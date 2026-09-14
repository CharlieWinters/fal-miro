// "Settings card" — a board Card that snapshots a generation's model + inputs
// as JSON in its description, so it can be reconnected (new images/video/
// prompt wired to it via connectors) and rerun later. See CapabilityIcon-era
// board patterns: this is the same "board as a form" idea, made persistent.
//
// Stored as compact (no pretty-printing) JSON — Miro's Card `description` may
// wrap the value in its own light HTML (e.g. a single <p> tag); parsing strips
// any tags first. Keeping the JSON on one line means there's no whitespace for
// that round trip to disturb, regardless of how Miro wraps it.

import type { Capability } from './falCatalog';
import { cachedBoardGet, type ResolvedBoardItems } from './boardHelpers';
import { pickPromptField, type Field } from './schema';

export const RECIPE_CARD_VERSION = 1;

/** Which schema field a connected board resource should feed, and its shape. */
export type RecipeFieldRef = { name: string; multiple: boolean; required: boolean };

export type RecipeCard = {
  v: 1;
  /** The Fal endpoint this recipe runs. */
  endpointId: string;
  /** Kept alongside endpointId as a fallback — lets a future reopen route to
   *  the right screen/agent even if the model catalog can't be resolved. */
  capability: Capability;
  /** The model's non-connected argument values (aspect ratio, seed, strength…). */
  input: Record<string, unknown>;
  /** Image field a connected image should feed, if the model takes one. */
  referenceField?: RecipeFieldRef | null;
  /** Video field a connected Fal video should feed, if the model takes one. */
  videoReferenceField?: RecipeFieldRef | null;
};

export function serializeRecipeCard(recipe: RecipeCard): string {
  return JSON.stringify(recipe);
}

/**
 * Miro keeps a Card description as HTML, which does two things to the JSON.
 *
 * It may wrap the value in a tag, and it escapes the JSON's own quotes into
 * entities: `{"v":1}` comes back as `{&#34;v&#34;:1}`. Stripping tags alone
 * leaves the entities, and `JSON.parse` cannot read those — so every card
 * whose description was read back from the board, rather than held in memory
 * from the moment it was written, failed to parse and simply stopped being
 * recognised as a settings card. Cards made outside the app never worked at
 * all, since their description is always read back from storage.
 *
 * Tags are stripped *before* entities are decoded, so an escaped `&lt;` inside
 * a prompt survives instead of being read as markup and deleted.
 *
 * DOMParser rather than an innerHTML round trip: it is inert, so nothing in a
 * board description can fetch a resource while we are only after its text.
 */
function decodeCardDescription(description: string): string {
  const withoutTags = description.replace(/<[^>]+>/g, '');
  try {
    const doc = new DOMParser().parseFromString(withoutTags, 'text/html');
    return (doc.documentElement.textContent ?? withoutTags).trim();
  } catch {
    return withoutTags.trim();
  }
}

/** Parse a Card's description back into a RecipeCard, or null if it isn't one. */
export function parseRecipeCard(description: string | undefined | null): RecipeCard | null {
  if (!description) return null;
  try {
    const v = JSON.parse(decodeCardDescription(description));
    if (v && typeof v === 'object' && v.v === RECIPE_CARD_VERSION && typeof v.endpointId === 'string') {
      return v as RecipeCard;
    }
  } catch {
    /* not a recipe card */
  }
  return null;
}

function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, '');
}

/** "Label: rest of text" → { label, rest }, or null if there's no colon. */
function splitLabelPrefix(content: string): { label: string; rest: string } | null {
  const m = content.match(/^([^:\n]{1,60}):\s*([\s\S]*)$/);
  if (!m) return null;
  return { label: m[1].trim(), rest: m[2].trim() };
}

/** Turn a sticky's post-colon text into a value matching the field's kind.
 *  Returns undefined if it doesn't parse (e.g. non-numeric text on a number
 *  field, or a value not in an enum's option list) — the override is skipped
 *  rather than corrupting the field with a bad value. */
function coerceForField(field: Field, text: string): unknown {
  switch (field.kind) {
    case 'integer': {
      const n = parseInt(text, 10);
      return Number.isNaN(n) ? undefined : n;
    }
    case 'number': {
      const n = parseFloat(text);
      return Number.isNaN(n) ? undefined : n;
    }
    case 'boolean': {
      if (/^(true|yes|on|1)$/i.test(text)) return true;
      if (/^(false|no|off|0)$/i.test(text)) return false;
      return undefined;
    }
    case 'enum':
      return (field.enumValues ?? []).find((v) => String(v).toLowerCase() === text.toLowerCase());
    case 'image':
    case 'video':
      // Handled by connector-based id resolution, not sticky text.
      return undefined;
    default:
      return text || undefined;
  }
}

/**
 * Connected stickies → field overrides. Generalizes the old PROMPT-only
 * convention: a sticky shaped "Label: value" sets whichever field's name or
 * label matches it (case/spacing-insensitive) — "Seed: 42", "Negative
 * prompt: blurry", "Aspect ratio: 16:9". `prompt` is just the common case of
 * this, not special-cased. A single sticky that matches no field (including
 * one with no colon at all) falls back to the model's primary text field
 * (`prompt`, or `text` for the models that call it that), so plain
 * single-sticky use still doesn't require typing a label.
 */
export function resolveStickyFieldOverrides(
  stickies: Array<{ content: string }>,
  fields: Field[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const unmatched: string[] = [];

  for (const s of stickies) {
    const split = splitLabelPrefix(s.content);
    const field = split
      ? fields.find(
          (f) => normalizeKey(f.name) === normalizeKey(split.label) || normalizeKey(f.label) === normalizeKey(split.label),
        )
      : undefined;
    if (split && field) {
      const value = coerceForField(field, split.rest);
      if (value !== undefined) out[field.name] = value;
    } else {
      unmatched.push(s.content);
    }
  }

  // Falls back to whichever field is this model's actual primary text field
  // — usually `prompt`, but some (mostly TTS) models call it `text`.
  const promptFieldName = pickPromptField(fields)?.name ?? 'prompt';
  if (!(promptFieldName in out) && unmatched.length === 1) {
    const text = unmatched[0].trim();
    if (text) out[promptFieldName] = text;
  }

  return out;
}

/** What a model screen needs to reopen a saved recipe: the static input plus
 *  whatever's currently connected to the card, resolved to concrete ids/text.
 *  `token` is unique per reopen so a screen can tell a fresh seed apart from a
 *  stale one even when reopening the same model twice in a row. */
export type RecipeSeed = {
  token: number;
  /** The card's own board id — the run's placement anchor (beside it if it
   *  still has connections when generated, below it if bare). */
  cardId: string;
  /** The card's parent frame, if it lives in a "prompt frame" — takes
   *  placement priority over `cardId` (output goes below the frame). */
  frameId?: string | null;
  input: Record<string, unknown>;
  referenceField?: RecipeFieldRef | null;
  videoReferenceField?: RecipeFieldRef | null;
  /** Connected images/videos with their board titles — titles matter here,
   *  not just cosmetically: the reference legend and the Seedance @Image/@Video
   *  token rewrite are keyed on the title, so a title-less id would silently
   *  show as "untitled" even though the connected item is actually named.
   *  Order is the basket order (see shared/referenceBinding.ts). */
  images: Array<{ id: string; title?: string }>;
  videos: Array<{ id: string; title?: string }>;
  audios: Array<{ id: string; title?: string }>;
  /** Raw connected stickies — resolved into field overrides once the target
   *  screen knows the model's fields (see `resolveStickyFieldOverrides`). */
  stickies: Array<{ content: string }>;
};

/** A settings card found on the board, ready to reopen. */
export type RecipeCardRef = {
  id: string;
  title?: string;
  recipe: RecipeCard;
};

/**
 * Every settings card on the board, newest last (board order).
 *
 * The selection-driven route needs the user to know that selecting a Card is
 * what surfaces the reopen tile, and it silently offers nothing when a
 * description does not parse. This is the direct route: one board query,
 * on demand, no selection involved and no listener kept open.
 *
 * `cachedBoardGet` means repeated scans within a couple of seconds cost one
 * SDK call, not several.
 */
export async function listRecipeCards(): Promise<RecipeCardRef[]> {
  const cards = (await cachedBoardGet('card')) as Array<{
    id?: string;
    title?: string;
    description?: string;
  }>;
  const out: RecipeCardRef[] = [];
  for (const card of cards) {
    if (!card?.id) continue;
    const recipe = parseRecipeCard(card.description);
    if (!recipe) continue;
    out.push({ id: card.id, title: stripCardTitle(card.title), recipe });
  }
  return out;
}

/** Card titles come back as HTML too, and are shown as plain text. */
function stripCardTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  return decodeCardDescription(title) || undefined;
}

let nextSeedToken = 1;

export function buildRecipeSeed(
  recipe: RecipeCard,
  cardId: string,
  connected: ResolvedBoardItems,
  frameId?: string | null,
): RecipeSeed {
  return {
    token: nextSeedToken++,
    cardId,
    frameId,
    input: recipe.input,
    referenceField: recipe.referenceField ?? null,
    videoReferenceField: recipe.videoReferenceField ?? null,
    images: connected.images.map((i) => ({ id: i.id, title: i.title })),
    videos: connected.videos.map((v) => ({ id: v.id, title: v.title })),
    audios: connected.audios.map((a) => ({ id: a.id, title: a.title })),
    stickies: connected.stickies,
  };
}
