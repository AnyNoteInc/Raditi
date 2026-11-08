// The types of stack-files.mjs, which stack-files.test.ts imports: the package is strict without
// allowJs.
export interface StackFile {
  /** The file name in its folder: `preview-wp-config.php`. */
  name: string
  /** From the root of the repository: `infra/wordpress/preview-wp-config.php`. */
  path: string
  /** The constant it is embedded as: `previewWpConfigPhp`. */
  constant: string
  text: string
}

export const EMBEDDED: Readonly<Record<string, string>>
export function constantOf(name: string): string
export function stackFiles(rootUrl: URL, folder: string): StackFile[]
