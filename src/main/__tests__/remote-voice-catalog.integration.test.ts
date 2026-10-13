import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import {
  listRemoteVoices,
  synthesizeRemoteVoice,
} from "../remote-media-runtime";

let boundary: Server | undefined;
afterEach(async () => {
  if (boundary)
    await new Promise<void>((resolve) => boundary!.close(() => resolve()));
});

it.each(["kokoro-82m-v1.0.onnx", "other-tts"])(
  "reads remote OGAD voices for %s and sends the selected voice",
  async (model) => {
    boundary = createServer(async (req, res) => {
      if (req.headers.authorization !== "Bearer fixture-key") {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/v1/audio/voices") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            voices: ["af_heart", "hf_alpha", "ff_siwis", 9, null, ""],
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/v1/audio/speech") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const payload = JSON.parse(body);
        if (
          payload.voice !== "hf_alpha" ||
          payload.model !== model ||
          payload.input !== "नमस्ते"
        ) {
          res.writeHead(400);
          res.end();
          return;
        }
        res.setHeader("content-type", "audio/wav");
        res.end("fixture-audio");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      boundary!.listen(0, "127.0.0.1", resolve),
    );
    const address = boundary.address();
    if (!address || typeof address === "string")
      throw Error("Missing fixture port");
    const server = {
      id: model,
      name: "Fixture",
      provider: "ogad" as const,
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      selectedModel: model,
      model,
      apiKey: "fixture-key",
      screenFramesAllowed: false,
    };
    const voices = await listRemoteVoices(server);
    expect(voices.map((v) => v.id)).toEqual([
      "af_heart",
      "hf_alpha",
      "ff_siwis",
    ]);
    expect(voices.map((v) => v.language)).toEqual(
      model.startsWith("kokoro")
        ? ["en-US", "hi", "fr"]
        : [undefined, undefined, undefined],
    );
    const audio = await synthesizeRemoteVoice(server, "नमस्ते", voices[1]!.id);
    expect(audio.dataUrl).toBe(
      `data:audio/wav;base64,${Buffer.from("fixture-audio").toString("base64")}`,
    );
  },
);

/** The /v1/models entry a packaged Off Grid gateway serves for its Kokoro speech model. */
const GATEWAY_SPEECH_ENTRY = {
  id: "kokoro-82m-v1.0.onnx",
  object: "model",
  owned_by: "off-grid",
  kind: "speech",
  voices: ["af_heart", "bf_emma", "df_anna", "hf_alpha", "pm_mateusz"],
  supported_voices: ["af_heart", "bf_emma", "df_anna", "hf_alpha", "pm_mateusz"],
  architecture: { input_modalities: ["text"], output_modalities: ["speech"] },
};

async function serveJson(routes: Record<string, unknown>): Promise<string> {
  boundary = createServer((req, res) => {
    const body = routes[`${req.method} ${req.url}`];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => boundary!.listen(0, "127.0.0.1", resolve));
  const address = boundary.address();
  if (!address || typeof address === "string") throw Error("Missing fixture port");
  return `http://127.0.0.1:${address.port}/v1`;
}

function compatibleServer(
  endpoint: string,
  model: string,
): Parameters<typeof listRemoteVoices>[0] {
  return {
    id: `custom:${model}`,
    name: "GPU pod",
    provider: "custom" as const,
    endpoint,
    selectedModel: model,
    model: "",
    apiKey: "",
    screenFramesAllowed: false,
  };
}

it("reads Kokoro speakers and languages from an OpenAI-compatible gateway's model catalog", async () => {
  const endpoint = await serveJson({
    "GET /v1/models?output_modalities=speech": { object: "list", data: [GATEWAY_SPEECH_ENTRY] },
  });
  expect(await listRemoteVoices(compatibleServer(endpoint, "kokoro-82m-v1.0.onnx"))).toEqual([
    { id: "af_heart", label: "Heart", language: "en-US", languageLabel: "English (US)" },
    { id: "bf_emma", label: "Emma", language: "en-GB", languageLabel: "English (UK)" },
    { id: "df_anna", label: "Anna", language: "de", languageLabel: "German" },
    { id: "hf_alpha", label: "Alpha", language: "hi", languageLabel: "Hindi" },
    { id: "pm_mateusz", label: "Mateusz", language: "pl", languageLabel: "Polish" },
  ]);
});

it("falls back to a compatible server's speaker route when its catalog lists none", async () => {
  const endpoint = await serveJson({
    "GET /v1/models?output_modalities=speech": { data: [{ id: "kokoro-v1", kind: "speech" }] },
    "GET /v1/audio/voices": { voices: ["ff_siwis"] },
  });
  expect(await listRemoteVoices(compatibleServer(endpoint, "kokoro-v1"))).toEqual([
    { id: "ff_siwis", label: "Siwis", language: "fr", languageLabel: "French" },
  ]);
});

it("offers no speakers when a compatible server lists none anywhere", async () => {
  const endpoint = await serveJson({
    "GET /v1/models?output_modalities=speech": { data: [{ id: "plain-tts", kind: "speech" }] },
  });
  expect(await listRemoteVoices(compatibleServer(endpoint, "plain-tts"))).toEqual([]);
});
