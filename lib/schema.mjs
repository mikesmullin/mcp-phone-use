// Minimal JSON Schema subset validator (copied from mcp-computer-use).
export function validate(schema, value, path = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
    for (const key of schema.required || []) if (!(key in value)) throw new Error(`${path}.${key} is required`);
    for (const [key, v] of Object.entries(value)) {
      if (!(key in (schema.properties || {}))) {
        if (schema.additionalProperties === false) throw new Error(`Unsupported argument ${path}.${key}`);
      } else validate(schema.properties[key], v, `${path}.${key}`);
    }
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) throw new Error(`${path} must be an integer`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} must be <= ${schema.maximum}`);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${path} must be a string`);
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${path} is too long`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} must be one of ${schema.enum.join(', ')}`);
}
