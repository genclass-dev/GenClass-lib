// A JSON Schema (draft-07 and the 2020-12 subset our manifests use) validator for the manifests this package ships, without dependencies. It implements the
// keywords the schemas we check use and throws on any other keyword, so a schema that starts using one fails the test
// instead of being half-checked. Annotations (description, examples, default, ...) are skipped.

type Schema = Record<string, unknown> | boolean;

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "title", "description", "default", "example", "examples", "definitions", "$defs", "readOnly", "writeOnly", "deprecated"]);
const CHECKED = new Set(["$ref", "type", "properties", "required", "additionalProperties", "items", "enum", "const", "pattern", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "uniqueItems", "format", "allOf", "anyOf", "oneOf", "not", "propertyNames"]);

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(want: string, v: unknown): boolean {
  const t = typeOf(v);
  return want === t || (want === "number" && t === "integer");
}

function formatOk(format: string, v: string): boolean {
  if (format === "uri") {
    try {
      return /^[a-z][a-z0-9+.-]*:/i.test(v) && !!new URL(v);
    } catch {
      return false;
    }
  }
  throw new Error(`jsonschema: format ${format} is not implemented`);
}

/** Every error (`path: message`) of `value` against `schema`; `root` resolves `#/...` references. */
export function validate(schema: Schema, value: unknown, root: Schema = schema, path = "$"): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: no value allowed`];
  for (const k of Object.keys(schema)) if (!CHECKED.has(k) && !ANNOTATIONS.has(k)) throw new Error(`jsonschema: keyword ${k} at ${path} is not implemented`);
  const errs: string[] = [];
  const s = schema as Record<string, any>;
  if (typeof s.$ref === "string") {
    if (!s.$ref.startsWith("#/")) throw new Error(`jsonschema: only local $ref is implemented (${s.$ref})`);
    let target: any = root;
    for (const part of s.$ref.slice(2).split("/")) target = target?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (target === undefined) throw new Error(`jsonschema: unresolved $ref ${s.$ref}`);
    errs.push(...validate(target, value, root, path));
  }
  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeMatches(t, value))) return [...errs, `${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
  }
  if (s.enum && !s.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) errs.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`);
  if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(value)) errs.push(`${path}: expected ${JSON.stringify(s.const)}`);
  if (typeof value === "string") {
    const len = [...value].length;
    if (s.minLength !== undefined && len < s.minLength) errs.push(`${path}: shorter than ${s.minLength} characters`);
    if (s.maxLength !== undefined && len > s.maxLength) errs.push(`${path}: ${len} characters, more than ${s.maxLength}`);
    if (s.pattern !== undefined && !new RegExp(s.pattern, "u").test(value)) errs.push(`${path}: does not match ${s.pattern}`);
    if (s.format !== undefined && !formatOk(s.format, value)) errs.push(`${path}: not a valid ${s.format}`);
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) errs.push(`${path}: below ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) errs.push(`${path}: above ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) errs.push(`${path}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) errs.push(`${path}: more than ${s.maxItems} items`);
    if (s.uniqueItems && new Set(value.map((x) => JSON.stringify(x))).size !== value.length) errs.push(`${path}: items are not unique`);
    if (s.items !== undefined) {
      if (Array.isArray(s.items)) throw new Error("jsonschema: tuple items are not implemented");
      value.forEach((x, i) => errs.push(...validate(s.items, x, root, `${path}[${i}]`)));
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in o)) errs.push(`${path}: missing ${r}`);
    const props: Record<string, Schema> = s.properties ?? {};
    if (s.propertyNames !== undefined) for (const k of Object.keys(o)) errs.push(...validate(s.propertyNames, k, root, `${path}{${k}}`));
    for (const [k, v] of Object.entries(o)) {
      if (k in props) errs.push(...validate(props[k], v, root, `${path}.${k}`));
      else if (s.additionalProperties !== undefined) errs.push(...validate(s.additionalProperties, v, root, `${path}.${k}`));
    }
  }
  for (const sub of s.allOf ?? []) errs.push(...validate(sub, value, root, path));
  if (s.anyOf && !s.anyOf.some((sub: Schema) => validate(sub, value, root, path).length === 0)) errs.push(`${path}: matches none of anyOf`);
  if (s.not !== undefined && validate(s.not, value, root, path).length === 0) errs.push(`${path}: matches a schema it must not match`);
  if (s.oneOf && s.oneOf.filter((sub: Schema) => validate(sub, value, root, path).length === 0).length !== 1) errs.push(`${path}: does not match exactly one of oneOf`);
  return errs;
}
