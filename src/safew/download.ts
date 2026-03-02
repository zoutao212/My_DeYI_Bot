import { detectMime } from "../media/mime.js";
import { type SavedMedia, saveMediaBuffer } from "../media/store.js";

export type SafewFileInfo = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
};

export async function getSafewFile(token: string, fileId: string): Promise<SafewFileInfo> {
  const res = await fetch(
    `https://api.safew.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  if (!res.ok) {
    throw new Error(`getFile failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { ok: boolean; result?: SafewFileInfo };
  if (!json.ok || !json.result?.file_path) {
    throw new Error("getFile returned no file_path");
  }
  return json.result;
}

export async function downloadSafewFile(
  token: string,
  info: SafewFileInfo,
  maxBytes?: number,
): Promise<SavedMedia> {
  if (!info.file_path) throw new Error("file_path missing");
  const url = `https://api.safew.org/file/bot${token}/${info.file_path}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download safew file: HTTP ${res.status}`);
  }
  const array = Buffer.from(await res.arrayBuffer());
  const mime = await detectMime({
    buffer: array,
    headerMime: res.headers.get("content-type"),
    filePath: info.file_path,
  });
  // save with inbound subdir
  const saved = await saveMediaBuffer(array, mime, "inbound", maxBytes);
  // Ensure extension matches mime if possible
  if (!saved.contentType && mime) saved.contentType = mime;
  return saved;
}
