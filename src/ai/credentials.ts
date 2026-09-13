/**
 * Where the AI layer gets its configuration.
 *
 * Until now that was `process.env` directly, which is right for a server and
 * useless for a build someone double-clicks: there is no shell to export a key
 * in. So the source is pluggable. The server layer installs one that reads a
 * settings file; the AI layer stays ignorant of where settings are kept, which
 * is what keeps it free of any dependency on the store.
 *
 * **The environment always wins.** A deployment configured by environment
 * variables must not be silently repointed by a settings file someone saved,
 * and CI must stay on the deterministic mock whatever is on the runner's disk.
 */

export type CredentialSource = (name: string) => string | undefined;

const NO_SOURCE: CredentialSource = () => undefined;

let source: CredentialSource = NO_SOURCE;

/** Install the fallback consulted when a variable is absent from the environment. */
export function setCredentialSource(next: CredentialSource): void {
  source = next;
}

/** Drop back to environment-only. Used by tests. */
export function resetCredentialSource(): void {
  source = NO_SOURCE;
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** The value of a setting, from the environment if set, otherwise from the installed source. */
export function credential(name: string): string | undefined {
  return clean(process.env[name]) ?? clean(source(name));
}

export type CredentialOrigin = 'environment' | 'settings' | 'none';

/**
 * Where a setting's value came from.
 *
 * The UI needs this to explain itself: a key stored in the settings file but
 * shadowed by one in the environment is not the key in use, and saying so is
 * better than showing a green tick against the wrong thing.
 */
export function credentialOrigin(name: string): CredentialOrigin {
  if (clean(process.env[name])) return 'environment';
  if (clean(source(name))) return 'settings';
  return 'none';
}
