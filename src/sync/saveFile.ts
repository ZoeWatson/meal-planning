/**
 * Getting a file out of the app, on both things the app runs on.
 *
 * The browser and the Android build disagree about what "download" means, and the
 * disagreement is silent rather than loud: an anchor with a `download` attribute
 * and a blob URL is the ordinary way to do this on the web, and inside Capacitor's
 * WebView it does nothing at all. No error, no file, no clue — which, for the one
 * button standing between the user and their only copy of their data, is the worst
 * possible failure.
 *
 * So the platform is checked rather than sniffed for feature support. Native
 * writes the file to the app's cache and opens the system share sheet, which is
 * how a file leaves an Android app — into Drive, a chat, a cable, wherever it is
 * going next. The cache rather than Documents because sharing needs no storage
 * permission from there, and this file's whole purpose is to be sent somewhere
 * else rather than to sit on the phone.
 */

import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export type SaveOutcome =
  /** The browser put it in the downloads folder. */
  | { readonly kind: 'downloaded'; readonly filename: string }
  /** The share sheet opened and the user sent it somewhere. */
  | { readonly kind: 'shared'; readonly filename: string }
  /** The share sheet opened and the user backed out. Not an error. */
  | { readonly kind: 'cancelled' };

export async function saveTextFile(
  filename: string,
  text: string,
  mimeType = 'application/json',
): Promise<SaveOutcome> {
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    return { kind: 'downloaded', filename };
  }

  await Filesystem.writeFile({
    path: filename,
    data: text,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  });

  const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Cache });

  try {
    await Share.share({ title: filename, files: [uri] });
    return { kind: 'shared', filename };
  } catch (err) {
    // Dismissing the share sheet rejects, which is not a failure worth showing as
    // one. Anything else is, so it is rethrown rather than swallowed wholesale.
    if (isShareDismissal(err)) return { kind: 'cancelled' };
    throw err;
  }
}

function isShareDismissal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cancel|abort|dismiss/i.test(message);
}
