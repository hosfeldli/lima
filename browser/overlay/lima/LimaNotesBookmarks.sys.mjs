/* Notes are bookmarks.
 *
 * Every note is a bookmark whose URL is about:lima?note=<id>. The bookmark
 * tree is the note organization: folders are note folders, the bookmark
 * title is the note title, moving the bookmark moves the note. Note content
 * stays in Lima's encrypted store; only titles live in places.sqlite.
 *
 * Deleting a note's last bookmark moves the note to Lima's trash (content
 * kept, restorable) instead of destroying it. Undoing the bookmark delete
 * restores it. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
  broadcastToLimaPages: "resource://lima/actors/LimaParent.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

export const NOTE_URL_PREFIX = "about:lima?note=";
const FOLDER_PREF = "lima.notes.defaultFolderGuid";
const TRASH_DELAY_MS = 1500;

function log(message) {
  dump(`[lima] notes-bookmarks: ${message}\n`);
}

export function noteURL(id) {
  return NOTE_URL_PREFIX + encodeURIComponent(id);
}

export function noteIdFromURL(url) {
  if (typeof url !== "string" || !url.startsWith(NOTE_URL_PREFIX)) return null;
  return decodeURIComponent(url.slice(NOTE_URL_PREFIX.length).split("&")[0]);
}

class NotesBookmarks {
  #started = false;
  #pendingTrash = new Map();
  /** Writes we made ourselves, so observers don't echo them back. */
  #ownWrites = new Set();

  async start() {
    if (this.#started) return;
    this.#started = true;
    lazy.PlacesUtils.observers.addListener(
      ["bookmark-added", "bookmark-removed", "bookmark-title-changed", "bookmark-url-changed"],
      events => this.#onPlacesEvents(events).catch(error => log(`observer failed: ${error}`))
    );
    lazy.LimaBridge.onEvent(message => {
      if (message.event === "notes.changed") this.#onNoteChanged(message.data).catch(error => log(`sync failed: ${error}`));
      if (message.event === "notes.deleted") this.#removeBookmarksFor(message.data.id).catch(() => {});
    });
    await this.reconcile();
  }

  async defaultFolderGuid() {
    const saved = Services.prefs.getStringPref(FOLDER_PREF, "");
    if (saved && (await lazy.PlacesUtils.bookmarks.fetch(saved))) return saved;
    const folder = await lazy.PlacesUtils.bookmarks.insert({
      parentGuid: lazy.PlacesUtils.bookmarks.menuGuid,
      type: lazy.PlacesUtils.bookmarks.TYPE_FOLDER,
      title: "Notes",
    });
    Services.prefs.setStringPref(FOLDER_PREF, folder.guid);
    return folder.guid;
  }

  /** All note bookmarks: [{guid, noteId, title, parentGuid}]. */
  async noteBookmarks() {
    const db = await lazy.PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT b.guid, b.title, h.url, p.guid AS parentGuid
         FROM moz_bookmarks b
         JOIN moz_places h ON h.id = b.fk
         JOIN moz_bookmarks p ON p.id = b.parent
        WHERE h.url LIKE :like`,
      { like: NOTE_URL_PREFIX + "%" }
    );
    return rows.map(row => ({
      guid: row.getResultByName("guid"),
      title: row.getResultByName("title") ?? "",
      noteId: noteIdFromURL(row.getResultByName("url")),
      parentGuid: row.getResultByName("parentGuid"),
    }));
  }

  /** Startup: make the bookmark tree and the note store agree. */
  async reconcile() {
    let notes;
    try {
      notes = await lazy.LimaBridge.request("notes.list");
    } catch (error) {
      log(`runtime unavailable, skipping reconcile: ${error.message}`);
      return;
    }
    const bookmarks = await this.noteBookmarks();
    const byNote = new Map();
    for (const bookmark of bookmarks) {
      if (!byNote.has(bookmark.noteId)) byNote.set(bookmark.noteId, []);
      byNote.get(bookmark.noteId).push(bookmark);
    }
    let created = 0, retitled = 0, restored = 0, trashed = 0;
    for (const note of notes) {
      const marks = byNote.get(note.id);
      if (!marks) {
        if (note.trashed) continue;
        // A note without a bookmark (new from an agent/MCP, or migrated):
        // give it one so it lives in the tree.
        await this.#insertBookmark(note.id, note.title, await this.defaultFolderGuid());
        created++;
        continue;
      }
      if (note.trashed) {
        await lazy.LimaBridge.request("notes.restore", { id: note.id });
        restored++;
      }
      // Bookmark title is the note title.
      const title = marks[0].title;
      if (title && title !== note.title) {
        await this.#setNoteTitle(note.id, title);
        retitled++;
      }
    }
    lazy.broadcastToLimaPages("notes.bookmarks");
    log(`reconciled ${notes.length} notes (created ${created}, retitled ${retitled}, restored ${restored}, trashed ${trashed})`);
  }

  async folderTree() {
    const bookmarks = await this.noteBookmarks();
    const folders = new Map();
    for (const bookmark of bookmarks) {
      if (!folders.has(bookmark.parentGuid)) {
        const folder = await lazy.PlacesUtils.bookmarks.fetch(bookmark.parentGuid);
        folders.set(bookmark.parentGuid, { guid: bookmark.parentGuid, title: this.#folderTitle(folder), notes: [] });
      }
      folders.get(bookmark.parentGuid).notes.push({ id: bookmark.noteId, title: bookmark.title, bookmarkGuid: bookmark.guid });
    }
    const defaultGuid = await this.defaultFolderGuid();
    if (!folders.has(defaultGuid)) folders.set(defaultGuid, { guid: defaultGuid, title: "Notes", notes: [] });
    // Include empty child folders of the default folder so they can receive notes.
    await lazy.PlacesUtils.bookmarks.fetch({ parentGuid: defaultGuid }, child => {
      if (child.type === lazy.PlacesUtils.bookmarks.TYPE_FOLDER && !folders.has(child.guid)) {
        folders.set(child.guid, { guid: child.guid, title: child.title, notes: [] });
      }
    });
    return { defaultGuid, folders: [...folders.values()] };
  }

  #folderTitle(folder) {
    if (!folder) return "Notes";
    const roots = {
      [lazy.PlacesUtils.bookmarks.toolbarGuid]: "Bookmarks Toolbar",
      [lazy.PlacesUtils.bookmarks.menuGuid]: "Bookmarks Menu",
      [lazy.PlacesUtils.bookmarks.unfiledGuid]: "Other Bookmarks",
    };
    return roots[folder.guid] ?? folder.title ?? "Folder";
  }

  async createNote({ title = "", kind = "classic", markdown = "", folderGuid = null } = {}) {
    const note = await lazy.LimaBridge.request("notes.create", { title, kind, markdown });
    // notes.changed will also arrive; #insertBookmark is idempotent per note.
    await this.#insertBookmark(note.id, note.title, folderGuid ?? (await this.defaultFolderGuid()));
    return note;
  }

  async createFolder(title, parentGuid = null) {
    const folder = await lazy.PlacesUtils.bookmarks.insert({
      parentGuid: parentGuid ?? (await this.defaultFolderGuid()),
      type: lazy.PlacesUtils.bookmarks.TYPE_FOLDER,
      title: title || "New Folder",
    });
    return { guid: folder.guid, title: folder.title };
  }

  async moveNote(noteId, folderGuid) {
    const [bookmark] = (await this.noteBookmarks()).filter(b => b.noteId === noteId);
    if (!bookmark) return false;
    await lazy.PlacesUtils.bookmarks.update({ guid: bookmark.guid, parentGuid: folderGuid, index: lazy.PlacesUtils.bookmarks.DEFAULT_INDEX });
    return true;
  }

  /** Delete from the UI = remove its bookmarks; the observer trashes the note. */
  async trashNote(noteId) {
    await this.#removeBookmarksFor(noteId);
    await lazy.LimaBridge.request("notes.trash", { id: noteId });
    return true;
  }

  async restoreNote(noteId) {
    const note = await lazy.LimaBridge.request("notes.restore", { id: noteId });
    await this.#insertBookmark(note.id, note.title, await this.defaultFolderGuid());
    return note;
  }

  // MARK: Places → notes

  async #onPlacesEvents(events) {
    if (events.some(e => noteIdFromURL(e.url) || e.itemType === lazy.PlacesUtils.bookmarks.TYPE_FOLDER)) {
      lazy.broadcastToLimaPages("notes.bookmarks");
    }
    for (const event of events) {
      if (this.#ownWrites.has(event.guid)) {
        if (event.type !== "bookmark-added") this.#ownWrites.delete(event.guid);
        continue;
      }
      switch (event.type) {
        case "bookmark-added": {
          const noteId = noteIdFromURL(event.url);
          if (!noteId) break;
          lazy.clearTimeout(this.#pendingTrash.get(noteId));
          this.#pendingTrash.delete(noteId);
          const notes = await lazy.LimaBridge.request("notes.list");
          const note = notes.find(n => n.id === noteId);
          if (note?.trashed) await lazy.LimaBridge.request("notes.restore", { id: noteId });
          if (note && event.title && event.title !== note.title) await this.#setNoteTitle(noteId, event.title);
          break;
        }
        case "bookmark-removed": {
          const noteId = noteIdFromURL(event.url);
          if (!noteId) break;
          // Cut/paste and undo re-add quickly; only trash if no bookmark
          // for this note remains after a short delay.
          lazy.clearTimeout(this.#pendingTrash.get(noteId));
          this.#pendingTrash.set(noteId, lazy.setTimeout(async () => {
            this.#pendingTrash.delete(noteId);
            const remaining = (await this.noteBookmarks()).some(b => b.noteId === noteId);
            if (!remaining) {
              await lazy.LimaBridge.request("notes.trash", { id: noteId }).catch(() => {});
              log(`note ${noteId} moved to trash (bookmark deleted)`);
            }
          }, TRASH_DELAY_MS));
          break;
        }
        case "bookmark-title-changed": {
          const bookmark = await lazy.PlacesUtils.bookmarks.fetch(event.guid);
          const noteId = noteIdFromURL(bookmark?.url?.href);
          if (noteId && event.title) await this.#setNoteTitle(noteId, event.title);
          break;
        }
      }
    }
  }

  async #setNoteTitle(noteId, title) {
    const note = await lazy.LimaBridge.request("notes.get", { id: noteId }).catch(() => null);
    if (!note || note.title === title) return;
    await lazy.LimaBridge.request("notes.apply", { id: noteId, edits: [{ setTitle: { _0: title } }], author: "user" });
  }

  // MARK: Notes → Places

  async #onNoteChanged(note) {
    if (!note?.id || note.trashedAt) return;
    const marks = (await this.noteBookmarks()).filter(b => b.noteId === note.id);
    if (!marks.length) {
      await this.#insertBookmark(note.id, note.title, await this.defaultFolderGuid());
      return;
    }
    for (const mark of marks) {
      if (mark.title !== note.title) {
        this.#ownWrites.add(mark.guid);
        await lazy.PlacesUtils.bookmarks.update({ guid: mark.guid, title: note.title });
      }
    }
  }

  /** In-flight inserts per note, so concurrent callers (createNote and the
   * notes.changed observer) never create duplicate bookmarks. */
  #inserting = new Map();

  #insertBookmark(noteId, title, parentGuid) {
    if (this.#inserting.has(noteId)) return this.#inserting.get(noteId);
    const task = (async () => {
      if ((await this.noteBookmarks()).some(b => b.noteId === noteId)) return;
      const guid = lazy.PlacesUtils.history.makeGuid();
      this.#ownWrites.add(guid);
      await lazy.PlacesUtils.bookmarks.insert({ guid, parentGuid, url: noteURL(noteId), title: title || "Untitled" });
      lazy.broadcastToLimaPages("notes.bookmarks");
    })().finally(() => this.#inserting.delete(noteId));
    this.#inserting.set(noteId, task);
    return task;
  }

  async #removeBookmarksFor(noteId) {
    for (const mark of (await this.noteBookmarks()).filter(b => b.noteId === noteId)) {
      this.#ownWrites.add(mark.guid);
      await lazy.PlacesUtils.bookmarks.remove(mark.guid);
    }
  }
}

export const LimaNotesBookmarks = new NotesBookmarks();
