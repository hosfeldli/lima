const pending = new WeakMap();

/** Zen normally reveals a folder when a tab or folder joins it. Background
 * changes use the same creation guard as Zen's own folder builder. */
export function preserveFolderDisclosure(folder, change) {
  if (!folder) return change();
  if (!pending.has(folder)) {
    pending.set(folder, folder.creating);
    folder.creating = true;
    // TabGrouped is delivered by the group's mutation observer.
  }
  try {
    return change();
  } finally {
    Promise.resolve().then(() => {
      if (!pending.has(folder)) return;
      folder.creating = pending.get(folder);
      pending.delete(folder);
    });
  }
}
