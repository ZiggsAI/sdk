import { defineTool } from '../tools/defineTool.js';
import {
  skillReferenceName,
  type ParsedSkill,
} from './parseSkill.js';

/**
 * Fetch one skill reference by catalog name. The role prompt lists names and
 * one line each; this is how the rest of the file is loaded.
 */
export function skillReadReferenceTool(skill: ParsedSkill) {
  const byName = new Map(
    skill.references.map((ref) => [skillReferenceName(ref.path), ref]),
  );
  return defineTool(
    'skill_read_reference',
    {
      name: {
        type: 'string',
        required: true,
        description:
          'Reference name from the skill catalog (filename without .md)',
      },
    },
    async (args) => {
      const name = String(args['name'] ?? '').trim();
      const ref = byName.get(name);
      if (!ref) {
        const available = [...byName.keys()];
        throw new Error(
          `unknown skill reference "${name}". Available: ${available.join(', ') || '(none)'}`,
        );
      }
      return { name, path: ref.path, content: ref.content };
    },
    {
      description:
        'Read one skill reference by name. The catalog of names is in your role prompt.',
      isGenericFallback: true,
    },
  );
}
