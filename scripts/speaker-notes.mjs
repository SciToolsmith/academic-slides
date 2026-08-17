function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function first(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function clean(value) {
  if (typeof value === "string" || typeof value === "number") return String(value).replace(/\r\n/g, "\n").trim();
  if (Array.isArray(value)) return value.map(clean).filter(Boolean).join("；");
  if (!isObject(value)) return "";
  return clean(first(value.text, value.label, value.title, value.citation, value.value, value.name, ""));
}

function normalizeSource(item) {
  if (typeof item === "string") return clean(item);
  if (!isObject(item)) return clean(item);
  const citation = clean(first(item.citation, item.title, item.source, ""));
  const locator = clean(first(item.locator, item.url, ""));
  if (!citation && !locator) return "";
  if (!locator || citation.includes(locator)) return citation || locator;
  return [citation, locator].filter(Boolean).join("；");
}

export function normalizeSpeakerNotes(slideSpec = {}) {
  const legacy = isObject(slideSpec.notes) ? slideSpec.notes : {};
  const schema = isObject(slideSpec.speaker_notes) ? slideSpec.speaker_notes : {};
  const script = clean(first(
    legacy.speaker_notes,
    legacy.speakerNotes,
    legacy.talk_track,
    legacy.talkTrack,
    legacy.script,
    schema.script,
    slideSpec.speakerNotes,
    "",
  ));
  const transition = clean(first(schema.transition, legacy.transition, ""));
  const deliveryCues = list(first(schema.delivery_cues, legacy.delivery_cues, [])).map(clean).filter(Boolean);
  const sources = [...new Set(list(first(legacy.sources, schema.sources, slideSpec.sources, [])).map(normalizeSource).filter(Boolean))];
  return { script, transition, deliveryCues, sources };
}

export function serializeSpeakerNotes(slideSpec = {}) {
  const notes = normalizeSpeakerNotes(slideSpec);
  const body = [notes.script, notes.transition ? `过渡：${notes.transition}` : ""].filter(Boolean).join("\n\n");
  return [
    body,
    "",
    "",
    "[Sources]",
    ...notes.sources.map((source) => `- ${source}`),
    "[/Sources]",
  ].join("\n");
}

export const internal = Object.freeze({ clean, normalizeSource });
