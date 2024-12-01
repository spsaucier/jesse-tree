/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly NOUN_PROJECT_KEY: string;
  readonly NOUN_PROJECT_SECRET: string;
  readonly BIBLE_API_KEY: string;
  readonly RAPID_API_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
