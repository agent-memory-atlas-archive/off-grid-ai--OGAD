# Recommended model catalog

Off Grid AI Desktop ships its own catalog and fetches `models.json` from `main` only when someone
clicks **Check for new models** on the Models screen. A model added here reaches every install
without a release.

- List only models added after the last release. The app already ships its own catalog.
- An entry with the same `id` as a bundled model replaces it. Entries never remove a model.
  To retire one, set `supersededBy`.
- An entry with a missing or wrong required field is skipped. Required: `id`, `name`, `kind`
  (`text`, `vision`, `computer_use`, `image`, `voice`, `transcription`), and `files` (each with
  `name` and an `https://` `url`). Other fields follow `ModelEntry` in `@offgrid/models`.
- Raise `schemaVersion` only for a breaking change. Older apps then ignore the file.

```json
{
  "id": "unsloth/Example-4B-GGUF",
  "name": "Example 4B",
  "kind": "vision",
  "org": "example",
  "description": "Fast reasoning with vision",
  "params": 4,
  "minRamGb": 8,
  "quant": "Q4_K_M",
  "quality": 30,
  "releaseDate": "2026-10-20",
  "isNew": true,
  "files": [
    {
      "name": "Example-4B-Q4_K_M.gguf",
      "url": "https://huggingface.co/unsloth/Example-4B-GGUF/resolve/main/Example-4B-Q4_K_M.gguf",
      "sizeBytes": 2500000000,
      "role": "primary"
    },
    {
      "name": "mmproj-Example-4B-F16.gguf",
      "url": "https://huggingface.co/unsloth/Example-4B-GGUF/resolve/main/mmproj-F16.gguf",
      "sizeBytes": 600000000,
      "role": "mmproj"
    }
  ]
}
```
