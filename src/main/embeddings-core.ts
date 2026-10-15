import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  pipeline,
  type DeviceType,
  type FeatureExtractionPipeline,
  type PreTrainedModel,
  type PreTrainedTokenizer
} from '@huggingface/transformers'
import { modelReadDirectories, resolveTransformersPackage } from './model-paths'
import { requireModelStorage } from './runtime-env'
import { configureTransformersEnv } from './embeddings-env'
import { loadWithOnnxFallback, onnxDeviceCandidates } from './onnx-device'
import type { BackendPreference } from '../shared/backend-preferences'

/**
 * Text -> vector. The actual inference, owned in ONE place.
 *
 * It runs in two contexts and must behave identically in both: the worker thread (production, where
 * keeping native ONNX inference off the main thread is the whole point - see embeddings-worker.ts), and
 * in-process, where there is no built worker to spawn. Sharing the implementation is what keeps the
 * second path honest: the alternative was a second copy that could drift from the one users run.
 *
 * The pipeline is cached per process, because loading it is the expensive part.
 */
let pipe: FeatureExtractionPipeline | null = null
let loading: Promise<FeatureExtractionPipeline> | null = null
let activeDevice: DeviceType | null = null

export function embeddingDevice(): DeviceType | null {
  return activeDevice
}

/** Called after serialized inference when the model is configured on demand. */
export async function disposeEmbeddingModel(): Promise<void> {
  const previous = pipe
  pipe = null
  loading = null
  activeDevice = null
  await previous?.dispose()
  const reranker = rerankerLoading
  rerankerLoading = null
  await (await reranker?.catch(() => null))?.model.dispose()
}

/**
 * Models for documents attached to chat. Passages are embedded with MiniLM, the model memory search
 * already keeps loaded: measured ~15 ms a passage on CPU here, where multilingual-e5-small (q8) took
 * ~1.7 s, which made a long book index for over an hour. Indian-language documents still match by
 * keyword (FTS5 keeps their words whole). ms-marco-MiniLM-L-6-v2 is the cross-encoder AnythingLLM's
 * native reranker uses.
 */
export const DOCUMENT_EMBEDDER = 'Xenova/all-MiniLM-L6-v2'
export const DOCUMENT_RERANKER = 'Xenova/ms-marco-MiniLM-L-6-v2'

let rerankerLoading: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | null =
  null

/** Quantized weights when present (smaller download); the model downloads on first use. */
function prepareModel(id: string, modelsDir: string, readDirectories: string[]): boolean {
  const cached = !!resolveTransformersPackage(id, 'model_quantized.onnx', readDirectories)
  if (!cached && process.env.OFFGRID_EMBEDDINGS_OFFLINE !== '1') requireModelStorage()
  configureTransformersEnv(modelsDir, cached)
  return cached
}

/** Vectors for several texts, one by one: batching pads to the longest text and runs slower on CPU. */
export async function embedTexts(
  texts: string[],
  modelsDir: string,
  backendPreference: BackendPreference = 'auto',
  readDirectories = modelReadDirectories()
): Promise<number[][]> {
  const out: number[][] = []
  for (const text of texts)
    out.push(await embedText(text, modelsDir, undefined, backendPreference, readDirectories))
  return out
}

/** Relevance of each passage to the query (sigmoid of the cross-encoder logit), same order. */
export async function rerankPassages(
  query: string,
  passages: string[],
  modelsDir: string,
  backendPreference: BackendPreference = 'auto',
  readDirectories = modelReadDirectories()
): Promise<number[]> {
  if (!passages.length) return []
  if (!rerankerLoading) {
    const cached = prepareModel(DOCUMENT_RERANKER, modelsDir, readDirectories)
    const options = cached ? { local_files_only: true } : {}
    rerankerLoading = Promise.all([
      AutoTokenizer.from_pretrained(DOCUMENT_RERANKER, options),
      loadWithOnnxFallback(
        (device) =>
          AutoModelForSequenceClassification.from_pretrained(DOCUMENT_RERANKER, {
            device,
            dtype: 'q8',
            ...options
          }),
        onnxDeviceCandidates(process.platform, backendPreference)
      ).then(({ runtime }) => runtime)
    ]).then(([tokenizer, model]) => ({ tokenizer, model }))
    rerankerLoading.catch(() => {
      rerankerLoading = null
    })
  }
  const { tokenizer, model } = await rerankerLoading
  const scores: number[] = []
  // Small groups keep padding low; the model reads query and passage together.
  for (let i = 0; i < passages.length; i += 6) {
    const group = passages.slice(i, i + 6)
    const inputs = tokenizer(new Array(group.length).fill(query), {
      text_pair: group,
      padding: true,
      truncation: true
    })
    const { logits } = await model(inputs)
    const values = (logits.sigmoid().tolist() as number[][]).map((row) => row[0] ?? 0)
    scores.push(...values)
  }
  return scores
}

export async function embedText(
  text: string,
  modelsDir: string,
  onReady?: (device: string, reason?: string) => void,
  backendPreference: BackendPreference = 'auto',
  readDirectories = modelReadDirectories()
): Promise<number[]> {
  if (!pipe) {
    const id = 'Xenova/all-MiniLM-L6-v2'
    const fp32 = resolveTransformersPackage(id, 'model.onnx', readDirectories)
    const cached = fp32 ?? resolveTransformersPackage(id, 'model_quantized.onnx', readDirectories)
    // Local-only reads must not require writable storage. Guard only an explicit
    // folder choice when the pipeline can download; default storage is created lazily.
    if (!cached && process.env.OFFGRID_EMBEDDINGS_OFFLINE !== '1') requireModelStorage()
    configureTransformersEnv(modelsDir, !!cached)
    loading ??= loadWithOnnxFallback(
      (device) =>
        pipeline('feature-extraction', cached ?? 'Xenova/all-MiniLM-L6-v2', {
          device,
          ...(cached ? { local_files_only: true, ...(fp32 ? {} : { dtype: 'q8' as const }) } : {})
        }),
      onnxDeviceCandidates(process.platform, backendPreference)
    )
      .then(({ runtime, device, fallbackReason }) => {
        onReady?.(device, fallbackReason)
        activeDevice = device
        return runtime
      })
      .catch((error) => {
        loading = null
        throw error
      })
    pipe = await loading
  }
  const output = await pipe(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}
