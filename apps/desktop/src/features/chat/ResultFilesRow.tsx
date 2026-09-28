import { useEffect, useState } from "react";
import {
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson2,
  FileSpreadsheet,
  FileText,
  FileVideo,
  LoaderCircle,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { fileExtension, openResultFile, resolveDeclaredFile } from "../../lib/open-result-file";
import { getDesktopFileInfo } from "../../lib/desktop-file-access";
import type { DeclaredResultFile } from "./result-files";

/** Icon + tint per file family, so chips read at a glance. */
type ResultFileGlyph = { Icon: LucideIcon; className: string };

const GLYPHS: Record<string, ResultFileGlyph> = {
  pdf: { Icon: FileText, className: "text-red-400" },
  word: { Icon: FileText, className: "text-blue-400" },
  sheet: { Icon: FileSpreadsheet, className: "text-green-400" },
  slides: { Icon: Presentation, className: "text-orange-400" },
  image: { Icon: FileImage, className: "text-purple-400" },
  code: { Icon: FileCode2, className: "text-teal-400" },
  markup: { Icon: FileText, className: "text-sky-400" },
  data: { Icon: FileJson2, className: "text-lime-400" },
  archive: { Icon: FileArchive, className: "text-amber-400" },
  audio: { Icon: FileAudio, className: "text-pink-400" },
  video: { Icon: FileVideo, className: "text-indigo-400" },
};

const GLYPH_EXTENSIONS: Record<keyof typeof GLYPHS, string[]> = {
  pdf: ["pdf"],
  word: ["doc", "docx", "docm", "dot", "dotx", "dotm", "rtf", "odt", "wps"],
  sheet: ["xls", "xlsx", "xlsm", "xlsb", "csv", "tsv", "ods", "et", "ett"],
  slides: ["ppt", "pptx", "pptm", "pps", "ppsx", "pot", "potx", "dps", "odp"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"],
  code: [
    "js",
    "jsx",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "c",
    "h",
    "cpp",
    "hpp",
    "cc",
    "cs",
    "php",
    "swift",
    "sh",
    "bash",
    "zsh",
    "ps1",
    "bat",
    "sql",
    "vue",
    "svelte",
    "dart",
    "lua",
    "r",
    "scala",
    "clj",
    "ex",
    "exs",
    "erl",
    "hs",
    "pl",
    "proto",
    "graphql",
    "gql",
  ],
  markup: ["md", "mdx", "markdown", "html", "htm", "xml", "css", "scss", "less"],
  data: ["json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "env", "conf", "cfg"],
  archive: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "iso"],
  audio: ["mp3", "wav", "flac", "ogg", "m4a"],
  video: ["mp4", "mkv", "avi", "mov", "webm", "wmv", "flv"],
};

const GENERIC_GLYPH: ResultFileGlyph = { Icon: FileText, className: "text-muted" };

function resultFileGlyph(path: string): ResultFileGlyph {
  const extension = fileExtension(path);
  for (const [glyph, extensions] of Object.entries(GLYPH_EXTENSIONS)) {
    if (extensions.includes(extension)) return GLYPHS[glyph as keyof typeof GLYPHS];
  }
  return GENERIC_GLYPH;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}

/** File size read from disk once the chip mounts; hidden when unavailable. */
function FileSizeTag({ absolute }: { absolute: string | null }) {
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  useEffect(() => {
    if (!absolute) return;
    let cancelled = false;
    getDesktopFileInfo(absolute)
      .then((info) => {
        if (!cancelled && !info.isDirectory) setSizeBytes(info.sizeBytes);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [absolute]);
  if (sizeBytes === null) return null;
  return <span className="shrink-0 text-muted">{formatBytes(sizeBytes)}</span>;
}

/**
 * Clickable chips for the files the agent declared as this turn's
 * deliverables, rendered at the end of the turn as `name · EXT · size`.
 * Documents open with the system default app, markdown and code files open in
 * their own right-dock tab.
 */
export function ResultFilesRow({ files }: { files: DeclaredResultFile[] }) {
  const t = useT();
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [pending, setPending] = useState<string | null>(null);
  if (files.length === 0) return null;

  const open = async (file: DeclaredResultFile) => {
    if (pending) return;
    setPending(file.path);
    try {
      const { outcome, error } = await openResultFile(file.path);
      if (outcome === "failed" || outcome === "no-workspace") {
        const label = t("resultFileOpenFailed", { name: file.path });
        pushNotification(error ? `${label}（${error}）` : label, "warning");
      }
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-result-files>
      {files.map((file) => {
        const { Icon, className } = resultFileGlyph(file.path);
        const busy = pending === file.path;
        const name = file.path.split(/[\\/]/).pop() ?? file.path;
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const extension = dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
        return (
          <button
            key={file.path}
            type="button"
            title={file.path}
            aria-label={t("resultFileOpen", { name: file.label ?? file.path })}
            disabled={busy}
            onClick={() => void open(file)}
            className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-accent/35 bg-accent/5 px-2 text-xs text-muted transition-colors hover:bg-accent/10 hover:text-foreground disabled:opacity-60"
          >
            {busy ? (
              <LoaderCircle size={12} className="shrink-0 animate-spin" />
            ) : (
              <Icon size={12} className={`shrink-0 ${className}`} aria-hidden="true" />
            )}
            <span className="max-w-48 truncate sm:max-w-72">{file.label ?? stem}</span>
            {extension && (
              <span className="shrink-0 rounded bg-surface-overlay px-1 font-mono text-[10px] uppercase leading-4 text-muted">
                {extension}
              </span>
            )}
            <FileSizeTag absolute={resolveDeclaredFile(file.path).absolute} />
          </button>
        );
      })}
    </div>
  );
}
