/** Node runtimes receive configuration through their process environment. */
export interface RuntimeEnv extends NodeJS.ProcessEnv {
  TYPESAFE_API_KEY?: string;
  TYPESAFE_MODEL?: string;
  VOYAGE_API_KEY?: string;
  VOYAGE_MODEL?: string;
  VOYAGE_DIMENSIONS?: string;
  INPUT_INTERPRETER?: string;
  BIPLAN_PREVIEW_TESTING?: string;
}

export const env: RuntimeEnv = process.env;
