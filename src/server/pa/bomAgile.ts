// Agile PLM 匯出的 BOM（.xls，舊版 Excel 格式）。
// 一列一個 BOM 項目，Level 是階層（0 = 最上層組件）、BOM.Find Num 是項次（4-1 是 4 的替代料）。
// 解析成跟 PLM BOM PDF 一樣的結構，後面的匯入流程就共用。

import * as XLSX from "xlsx";
import type { ParsedRow } from "./bom";
import { BomPdfError, type PdfHeader, type PdfParseResult } from "./bomPdf";

/** 舊版 .xls 是 OLE2 容器，開頭固定是這 8 個位元組 */
export function isXls(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  return b.length === 8 && [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((v, i) => b[i] === v);
}

const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

export function parseAgileXls(buf: ArrayBuffer): PdfParseResult {
  let grid: unknown[][];
  try {
    const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) throw new Error("empty");
    grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false });
  } catch {
    throw new BomPdfError("讀不到這個 .xls 檔案，請確認是 Agile PLM 匯出的 BOM");
  }

  const head = (grid[0] ?? []).map(norm);
  const col = (name: string) => head.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const c = {
    level: col("Level"),
    pn: col("Part Number"),
    desc: col("Part Name / Description"),
    life: col("Lifecycle Phase"),
    rev: col("Rev"),
    find: col("BOM.Find Num"),
    qty: col("BOM.Quantity"),
    ref: col("BOM.Ref Des"),
    mfr: col("Manufacturers.Mfr Name"),
  };
  if (c.level < 0 || c.pn < 0) throw new BomPdfError("這個 .xls 沒有 Level / Part Number 欄位，不是 Agile PLM 的 BOM 匯出檔");

  const cell = (r: unknown[], i: number) => (i < 0 ? "" : norm(r[i]));
  const warnings: string[] = [];
  let header: PdfHeader | null = null;
  const rows: ParsedRow[] = [];
  const parentByDepth = new Map<number, string>();
  const findNumToPn = new Map<string, string>();

  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const pn = cell(r, c.pn);
    const levelText = cell(r, c.level);
    if (!pn && !levelText) continue;
    const depth = Number(levelText);
    if (!pn || !Number.isInteger(depth) || depth < 0) {
      warnings.push(`第 ${i + 1} 列沒有料號或階層，略過`);
      continue;
    }
    if (depth === 0) {
      if (!header) {
        header = {
          top_pn: pn,
          top_desc: cell(r, c.desc),
          lifecycle: cell(r, c.life),
          revision: cell(r, c.rev).split(/\s+/)[0] ?? "",
          change: (cell(r, c.rev).match(/\b([A-Z]{2,4}-\d{4,})\b/) ?? [])[1] ?? "",
        };
        parentByDepth.set(0, pn);
      }
      continue;
    }
    if (!header) throw new BomPdfError("讀不到最上層組件（Level 0）的料號");

    parentByDepth.set(depth, pn);
    const parent_pn = parentByDepth.get(depth - 1) ?? header.top_pn;
    const find = cell(r, c.find);
    const key = `${depth}|${parent_pn}|`;
    let alt_of_pn = "";
    if (find.includes("-")) alt_of_pn = findNumToPn.get(key + find.split("-")[0]) ?? "";
    else findNumToPn.set(key + find, pn);

    rows.push({
      line: rows.length + 1,
      values: {
        part_pn: pn,
        // 跟 PDF 匯入一樣:主料料號記最上層組件,實際上一階存在 parent_pn
        main_pn: header.top_pn,
        fg_model: header.top_desc,
        fg_desc: header.top_desc,
        part_desc: cell(r, c.desc),
        supplier: cell(r, c.mfr),
        bom_level: String(depth),
        parent_pn,
        find_num: find,
        alt_of_pn,
        qty: cell(r, c.qty),
        ref_des: cell(r, c.ref),
      },
      issues: [],
      notes: [],
    });
  }

  if (!header) throw new BomPdfError("讀不到最上層組件（Level 0）的料號");
  if (!rows.length) throw new BomPdfError("這個 .xls 裡沒有任何料號");
  return { header, rows, warnings };
}
