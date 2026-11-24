# Contributing

Bug reports, reproducible tests and focused pull requests are welcome. For a larger architectural change, open an issue first so the design can be discussed before the implementation grows.

## Local development

Use Node.js 22+ and npm. From a clean checkout:

```sh
npm install
npm test
npm run typecheck
npm run demo
```

The unit and integration tests use temporary directories and simulated agents; they do not require OpenCode credentials. A real OpenCode smoke test is useful for adapter changes, but keep it opt-in and record the host/SDK versions and model settings when reporting results.

## Changes

Keep pull requests focused. Match the surrounding TypeScript style, preserve explicit permission checks, and add a regression test when fixing behavior. Avoid widening agent permissions, weakening required reviews or increasing model usage implicitly. Changes to persisted records must preserve older supported records or include a documented migration.

For concurrency changes, test both contention and failure paths. For economic changes, distinguish missing data from reported zero, and keep cached input, output and reasoning metrics separate. Document limits rather than presenting simulated behavior as real-provider evidence.

Before opening a pull request, run the checks above, update relevant docs and explain any checks that could not run. Never include private prompts, run histories, API keys, machine-specific paths or unreviewed diagnostic bundles.

By submitting a contribution, you agree that it is licensed under the project's MIT license.
