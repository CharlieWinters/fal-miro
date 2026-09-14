import { beforeEach, describe, expect, it, vi } from 'vitest';
// `listRecipeCards` is imported dynamically in its own block: boardHelpers
// caches board queries at module scope, so each test needs a fresh module.
import {
  RECIPE_CARD_VERSION,
  parseRecipeCard,
  seedFormState,
  serializeRecipeCard,
  type RecipeCard,
} from './recipeCard';
import type { Field } from './schema';

const RECIPE: RecipeCard = {
  v: 1,
  endpointId: 'minimax/h3/reference-to-video',
  capability: 'video',
  input: { prompt: 'Image 1 is the framing to hold.', aspect_ratio: '9:16', duration: 3 },
  referenceField: null,
  videoReferenceField: null,
};

/**
 * How Miro actually stores a card description: the JSON's own quotes escaped
 * into entities. Taken verbatim from a card read back off a real board.
 */
const AS_STORED =
  '{&#34;v&#34;:1,&#34;endpointId&#34;:&#34;minimax/h3/reference-to-video&#34;,&#34;capability&#34;:&#34;video&#34;,' +
  '&#34;input&#34;:{&#34;prompt&#34;:&#34;Image 1 is the framing to hold.&#34;,&#34;aspect_ratio&#34;:&#34;9:16&#34;,' +
  '&#34;duration&#34;:3},&#34;referenceField&#34;:null,&#34;videoReferenceField&#34;:null}';

describe('parseRecipeCard', () => {
  it('reads a description in the form Miro stores it', () => {
    // The regression: entity-escaped quotes are not JSON, so this used to
    // return null and the card stopped being recognised as a settings card.
    expect(parseRecipeCard(AS_STORED)).toEqual(RECIPE);
  });

  it('still reads plain JSON, as held in memory just after writing', () => {
    expect(parseRecipeCard(serializeRecipeCard(RECIPE))).toEqual(RECIPE);
  });

  it('survives Miro wrapping the value in a tag', () => {
    expect(parseRecipeCard(`<p>${AS_STORED}</p>`)).toEqual(RECIPE);
    expect(parseRecipeCard(`<p>${serializeRecipeCard(RECIPE)}</p>`)).toEqual(RECIPE);
  });

  it('keeps an escaped angle bracket inside a prompt instead of eating it', () => {
    // Tags have to be stripped before entities are decoded, or `&lt;b&gt;`
    // decodes into markup first and then gets deleted along with the text.
    const withAngle: RecipeCard = { ...RECIPE, input: { prompt: 'a < b, then <b> tags' } };
    const stored = serializeRecipeCard(withAngle)
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&#34;');
    expect(parseRecipeCard(stored)).toEqual(withAngle);
  });

  it('refuses anything that is not a settings card', () => {
    for (const v of [
      undefined,
      null,
      '',
      'just a note about the shot',
      '<p>Shot 4 — hero on the ridge</p>',
      '{"v":2,"endpointId":"fal-ai/x"}',
      '{"v":1}',
      '{"v":1,"endpointId":42}',
      '{ not json',
    ])
      expect(parseRecipeCard(v as string), String(v)).toBeNull();
  });

  it('round-trips through the version constant', () => {
    expect(RECIPE.v).toBe(RECIPE_CARD_VERSION);
  });
});

describe('seedFormState', () => {
  const promptField: Field = { name: 'prompt', label: 'Prompt', kind: 'text', required: true };
  const durationField: Field = { name: 'duration', label: 'Duration', kind: 'number', required: false };
  const seed = (input: Record<string, unknown>, stickies: Array<{ content: string }> = []) => ({
    input,
    stickies,
  });

  it('lifts the prompt out of the saved input so it can reach its own state', () => {
    // The bug this exists for: references-to-video merged the input into the
    // form only, and the form hides the prompt field, so the words vanished.
    const { prompt, values } = seedFormState(
      seed({ prompt: 'Image 1 is the framing to hold.', duration: 3 }),
      [promptField, durationField],
    );
    expect(prompt).toBe('Image 1 is the framing to hold.');
    expect(values).toEqual({ prompt: 'Image 1 is the framing to hold.', duration: 3 });
  });

  it('follows the schema when the model calls its prompt something else', () => {
    const textField: Field = { name: 'text', label: 'Text', kind: 'text', required: true };
    const { prompt } = seedFormState(seed({ text: 'read this aloud' }), [textField]);
    expect(prompt).toBe('read this aloud');
  });

  it('lets a connected sticky beat the card’s frozen snapshot', () => {
    const { prompt, values } = seedFormState(
      seed({ prompt: 'what the card saved', duration: 3 }, [{ content: 'Prompt: what is wired up now' }]),
      [promptField, durationField],
    );
    expect(prompt).toBe('what is wired up now');
    expect(values.duration).toBe(3);
  });

  it('reports no prompt rather than a wrong one', () => {
    expect(seedFormState(seed({ duration: 3 }), [promptField]).prompt).toBeNull();
    expect(seedFormState(seed({ prompt: 42 }), [promptField]).prompt).toBeNull();
    expect(seedFormState(seed({}), []).prompt).toBeNull();
  });

  it('still finds a prompt when the schema has not loaded any fields', () => {
    // Schema fetch failed and the screen fell back: the field list is empty,
    // but the card's own prompt should still come back.
    expect(seedFormState(seed({ prompt: 'from the card' }), []).prompt).toBe('from the card');
  });
});

describe('listRecipeCards', () => {
  const get = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    (globalThis as { miro?: unknown }).miro = { board: { get } };
  });

  const load = async () => (await import('./recipeCard')).listRecipeCards();

  it('returns every card whose description is a recipe, ignoring the rest', async () => {
    get.mockResolvedValue([
      { id: 'c1', title: 'Settings · MiniMax H3', description: AS_STORED },
      { id: 'c2', title: 'Shot 4 notes', description: '<p>hero on the ridge</p>' },
      { id: 'c3', description: undefined },
      { id: 'c4', title: '<p>Settings · Nano Banana</p>', description: serializeRecipeCard(RECIPE) },
    ]);

    const found = await load();

    expect(found.map((f) => f.id)).toEqual(['c1', 'c4']);
    expect(found[0].recipe.endpointId).toBe('minimax/h3/reference-to-video');
    // Titles are HTML too, and are rendered as plain text.
    expect(found[1].title).toBe('Settings · Nano Banana');
  });

  it('asks the board for cards only, and once', async () => {
    get.mockResolvedValue([]);
    await load();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith({ type: 'card' });
  });

  it('returns nothing rather than throwing when a card is malformed', async () => {
    get.mockResolvedValue([null, { title: 'no id', description: AS_STORED }, 'nonsense']);
    await expect(load()).resolves.toEqual([]);
  });
});
