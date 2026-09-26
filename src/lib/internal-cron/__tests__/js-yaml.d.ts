// No @types/js-yaml package exists in this repo and this test does not
// warrant adding a new dependency merely for typings. js-yaml is
// already installed and used at runtime as-is; this gives it a minimal
// ambient type so scheduler-config.test.ts's `.load()` call typechecks.
declare module 'js-yaml' {
  export function load(input: string): unknown
  const _default: { load: typeof load }
  export default _default
}
