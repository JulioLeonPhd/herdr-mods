// The world outside Herdr: code editors, Finder/Explorer. This computer only: a
// path on another machine means nothing to an app here.
import { appHome, exec, knownAgents, readTextFile, setShared, shared, window } from "herdr";
import { EDITORS } from "../files/model.js";
import {
  pickDetectEditors,
  pickOpenInEditor,
  pickOpenWithDefault,
  pickReveal,
  revealError,
} from "../files/shell.js";

const FOUND = "better-files.editors";
const ERROR = "better-files.error";

export const foundEditors = () => shared(FOUND) ?? [];

export const outsideMethods = {
  // macOS: one lookup per app ID, done once: Spotlight knows apps wherever they're
  // installed. Windows: one PowerShell process probes App Paths, PATH, and well-known
  // dirs for every candidate; first hit wins. Both store { name, bundle } or
  // { name, exe } entries in shared state.
  findEditors(cx, extra = []) {
    const platform = window()?.platform;
    if (platform === "windows") {
      cx.spawn(async (cx) => {
        const { program, args } = pickDetectEditors(EDITORS, extra, platform);
        const r = await exec(program, args, {}).catch(() => null);
        const fields = r?.code === 0 ? r.stdout.split("\0") : [];
        const found = [];
        for (let i = 0; i + 1 < fields.length; i += 2) found.push({ name: fields[i], exe: fields[i + 1] });
        setShared(FOUND, found);
        cx.notify();
      });
      return;
    }
    cx.spawn(async (cx) => {
      const found = [];
      for (const editor of [...EDITORS, ...extra]) {
        const r = await exec(
          "mdfind",
          [`kMDItemCFBundleIdentifier == '${String(editor.bundle).replace(/'/g, "")}'`],
          {},
        ).catch(() => null);
        if (r?.code === 0 && r.stdout.trim()) found.push(editor);
      }
      setShared(FOUND, found);
      cx.notify();
    });
  },

  // Show diff is only offered where Better Changes can answer it.
  findBetterChanges(cx) {
    cx.spawn(async (cx) => {
      const manifest = await readTextFile(`${appHome()}/mods/better-changes/mod.json`).catch(
        () => null,
      );
      setShared("better-files.has-changes", Boolean(manifest));
      cx.notify();
    });
  },

  findNewAgents(on, cx) {
    cx.spawn(async (cx) => {
      try {
        const known = await knownAgents({ on: on ?? null });
        setShared(
          "better-files.new-agents",
          known.filter((a) => a.installed).map((a) => ({ key: a.key, name: a.name, run: a.run })),
        );
      } catch {
        setShared("better-files.new-agents", []);
      }
      cx.notify();
    });
  },

  // Runs the platform's open command; a failure lands in the shared error slot the
  // sidebar renders as a message.
  async outside(pick, what) {
    const r = await exec(pick.program, pick.args, {}).catch((e) => ({ code: 1, stderr: String(e) }));
    if (r.code !== 0) setShared(ERROR, `Could not ${what}: ${r.stderr?.trim() || "it failed"}`);
    else setShared(ERROR, null);
  },

  openInEditor(editor, path) {
    return this.outside(pickOpenInEditor(editor, path, window()?.platform), `open it in ${editor.name}`);
  },

  openWithDefault(path) {
    return this.outside(pickOpenWithDefault(path, window()?.platform), "open it");
  },

  revealInFinder(path) {
    const platform = window()?.platform;
    return this.outside(pickReveal(path, platform), revealError(platform));
  },
};
