export interface BundledModel {
  id: string;
  family: string;
  license: string;
  revision: string;
  sha256: string;
  size: number;
  /** Hugging Face repo that holds the tokenizer.json, when it is not `id` itself. */
  source?: string;
}

const STRING_FIELDS = ['id', 'family', 'license', 'revision', 'sha256'] as const;

export function readModelList(json: unknown): BundledModel[] {
  const models = (json as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) {
    throw new Error('models.json: "models" must be an array');
  }
  return models.map((entry, i) => {
    const m = entry as Record<string, unknown> | null;
    if (typeof m !== 'object' || m === null) {
      throw new Error(`models.json: entry ${i} is not an object`);
    }
    for (const field of STRING_FIELDS) {
      if (typeof m[field] !== 'string' || m[field] === '') {
        throw new Error(`models.json: entry ${i} has invalid "${field}"`);
      }
    }
    if (typeof m.size !== 'number' || !Number.isFinite(m.size) || m.size < 0) {
      throw new Error(`models.json: entry ${i} has invalid "size"`);
    }
    if (m.source !== undefined && (typeof m.source !== 'string' || m.source === '')) {
      throw new Error(`models.json: entry ${i} has invalid "source"`);
    }
    return {
      ...(m.source !== undefined ? { source: m.source as string } : {}),
      id: m.id as string,
      family: m.family as string,
      license: m.license as string,
      revision: m.revision as string,
      sha256: m.sha256 as string,
      size: m.size,
    };
  });
}
