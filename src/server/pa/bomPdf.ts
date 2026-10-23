// PLM（Agile）「Print Preview」匯出的 BOM PDF 解析。
//
// 版面：每個零件是一列，列內垂直置中放 Level / Find Num / Item Number / Quantity，
// 品名與 Ref Des 會換行，下面再接一行製造商資料（Mfr Name / Mfr Part Number / Lifecycle / Preferred）。
// 文字的 y 座標不會對齊，所以：
//   1. 以 x 座標把文字歸到表頭定義的欄
//   2. 「有 Level 的行」= 零件錨點，「有 Active/1st 之類的行」= 製造商錨點
//   3. 其餘行照 y 距離歸給最近的錨點
//   4. 內容本身能判斷的欄不靠距離：Ref Des vs Lifecycle、數量 vs Preferred Status
// 這樣即使某一列很高（Ref Des 動輒 65 個位置）也不會串到隔壁零件。

import type { ParsedRow } from "./bom";

/** 解析不出來就丟這個，呼叫端（bom.ts）轉成 HttpError 400。
 *  這個檔案刻意不 import 任何東西，檢查腳本（node --experimental-strip-types）才能直接載入。 */
export class BomPdfError extends Error {}

export interface PdfHeader {
  /** BOM 最上層的組件料號，例如 002-D813-000 */
  top_pn: string;
  /** 「• 」後面那段組件品名 */
  top_desc: string;
  lifecycle: string; // 組件本身的 lifecycle（ES1…），不是個別零件的
  revision: string;
  change: string;
}

export interface PdfParseResult {
  header: PdfHeader;
  rows: ParsedRow[];
  warnings: string[];
}

const LIFECYCLE = /^(active|inactive|obsolete|preliminary|production|prototype|pending|unincorporated)$/i;
const PREFERRED = /^\d+(st|nd|rd|th)$/i;
const LEVEL = /^\.+\d*$/;
/** 「1-203-5550-001 CAP,22uF…」這種開頭＝製造商料號＋品名，不是零件自己的品名 */
const MFR_DESC_START = /^(\d-\d{3}-\d{4}-\d{3}|\d{3}-[A-Z0-9]{4}-\d{3})[A-Z]?(\s|$)/;

interface Line {
  y: number;
  cells: string[]; // 依表頭欄位切好
}

/** 一個零件：純量欄位取自「有 Level 的那一行」，品名／Ref Des／製造商名稱可能跨好幾行 */
interface Rec {
  level: string;
  find: string;
  pn: string;
  qty: string;
  desc: string[];
  refdes: string[];
  mfr: string[];
}

interface TextBit {
  s: string;
  x: number;
  y: number;
}

/** 表頭欄位的順序，索引就是 cells 的索引 */
const COL = { level: 0, find: 1, item: 2, desc: 3, refdes: 4, qty: 5, denom: 6 };

export async function parseBomPdf(buf: ArrayBuffer): Promise<PdfParseResult> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  } catch {
    throw new BomPdfError("讀不到這個 PDF");
  }

  const warnings: string[] = [];
  let header: PdfHeader | null = null;
  /** 每一欄的 x 起點，只有第一頁有表頭，後面幾頁沿用 */
  let xs: number[] | null = null;
  const records: Rec[] = [];
  /** 跨頁時，頁首那幾行（通常是上一頁最後一顆料的 Ref Des）要接回去 */
  let carry: { rec: Rec; kind: "item" | "mfr" } | null = null;

  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    const page = await doc.getPage(pageNo);
    const tc = await page.getTextContent();
    const bits: TextBit[] = [];
    for (const it of tc.items as { str: string; transform: number[] }[]) {
      const s = it.str.replace(/\s+/g, " ").trim();
      if (s) bits.push({ s, x: it.transform[4], y: Math.round(it.transform[5] * 2) / 2 });
    }
    if (!bits.length) continue;

    // 同一個 y 的文字算同一行
    const byY = new Map<number, TextBit[]>();
    for (const b of bits) {
      const a = byY.get(b.y) ?? [];
      a.push(b);
      byY.set(b.y, a);
    }
    const raw = [...byY.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, arr]) => ({ y, bits: arr.sort((p, q) => p.x - q.x) }));

    if (pageNo === 1) header = readHeader(raw);

    // 表頭（Level / Find Num / Item Number…）定義欄位的 x 起點；只有第一頁印表頭
    const headerLine = raw.find((l) => l.bits.some((b) => b.s === "Level") && l.bits.some((b) => b.s === "Item Number"));
    if (headerLine) xs = headerLine.bits.map((b) => b.x);
    if (!xs) {
      if (pageNo === 1) throw new BomPdfError("這個 PDF 沒有 BOM 表頭（Level / Item Number），請確認是 PLM 匯出的 BOM");
      continue;
    }
    const cols = xs;

    const lines: Line[] = raw
      .filter((l) => (headerLine ? l.y < headerLine.y : true))
      .map((l) => {
        const cells: string[] = new Array(cols.length).fill("");
        for (const b of l.bits) {
          let col = 0;
          for (let i = 0; i < cols.length; i++) if (b.x >= cols[i] - 3) col = i;
          cells[col] = cells[col] ? `${cells[col]} ${b.s}` : b.s;
        }
        return { y: l.y, cells };
      })
      // 第二列表頭（Mfr Name / Mfr Part Number…）與頁尾註記不是資料
      .filter((l) => l.cells.some(Boolean) && l.cells[COL.find] !== "Mfr Name" && !/^Printed by:/.test(l.cells[0] ?? ""));

    // 錨點：零件行（有 Level）與製造商行（有 Active / 1st 之類）
    const anchors: { y: number; kind: "item" | "mfr"; rec: Rec }[] = [];
    for (const l of lines) {
      if (LEVEL.test(l.cells[COL.level] ?? "")) {
        const rec: Rec = {
          level: l.cells[COL.level],
          find: l.cells[COL.find] ?? "",
          pn: l.cells[COL.item] ?? "",
          qty: PREFERRED.test(l.cells[COL.qty] ?? "") ? "" : l.cells[COL.qty] ?? "",
          desc: [],
          refdes: [],
          mfr: [],
        };
        records.push(rec);
        anchors.push({ y: l.y, kind: "item", rec });
      } else if (LIFECYCLE.test(l.cells[COL.refdes] ?? "") || PREFERRED.test(l.cells[COL.qty] ?? "")) {
        const rec = records[records.length - 1];
        if (rec) anchors.push({ y: l.y, kind: "mfr", rec });
      }
    }
    if (!anchors.length) continue;

    for (const l of lines) {
      // 頁首那幾行在第一個錨點之上 → 接回上一頁最後在填的那一格
      let target: { kind: "item" | "mfr"; rec: Rec } | null = null;
      if (carry && l.y > anchors[0].y) target = carry;
      else {
        let bestD = Infinity;
        for (const a of anchors) {
          const d = Math.abs(a.y - l.y);
          if (d < bestD || (d === bestD && a.kind === "item")) {
            target = a;
            bestD = d;
          }
        }
      }
      if (!target) continue;
      const desc = l.cells[COL.desc];
      const refdes = l.cells[COL.refdes];
      const name = l.cells[COL.find];
      // 只有「有 Level 的行」會在 Item Number 欄放料號；其他行放的是 Mfr Part Number，
      // 所以這種行整行都屬於製造商那一段——分頁把 Active/1st 切到下一頁時，
      // 光看 y 距離會誤判成零件品名。
      const isItemAnchor = LEVEL.test(l.cells[COL.level] ?? "");
      const kind: "item" | "mfr" = !isItemAnchor && l.cells[COL.item] ? "mfr" : target.kind;
      target = { kind, rec: target.rec };
      if (kind === "item") {
        // Agile 的 Mfr Part Description 常常是「料號 空白 品名」，而且它跟零件品名同一欄。
        // 分頁把製造商那一行的 Active/1st 切到下一頁時，光看 y 距離會把它當成品名的續行。
        // 零件自己的品名不會以「料號＋空白」開頭（會是 CAP,…、LABEL,… 這種）。
        if (desc && !MFR_DESC_START.test(desc)) target.rec.desc.push(desc);
        // Ref Des 欄放的是 Active/Inactive 就是製造商那一行的 lifecycle，不是位置
        if (refdes && !LIFECYCLE.test(refdes)) target.rec.refdes.push(refdes);
      } else {
        // 製造商只取名稱（可能換行），其餘（料號、品名、lifecycle）用不到
        if (name && !isItemAnchor) target.rec.mfr.push(name);
        if (refdes && !LIFECYCLE.test(refdes)) target.rec.refdes.push(refdes);
      }
      carry = { rec: target.rec, kind };
    }
  }

  if (!header?.top_pn) throw new BomPdfError("讀不到 BOM 表頭的組件料號");

  // ---------- 整理成料號 ----------
  const rows: ParsedRow[] = [];
  const parentByDepth = new Map<number, string>();
  const findNumToPn = new Map<string, string>(); // "深度|上一階|find num" → 料號，用來找替代料的本尊
  let line = 0;
  for (const rec of records) {
    line++;
    if (!rec.pn) {
      warnings.push(`第 ${line} 個項目沒有料號，略過`);
      continue;
    }
    const depth = rec.level.replace(/[^.]/g, "").length || 1;
    parentByDepth.set(depth, rec.pn);
    const parent_pn = depth <= 1 ? header.top_pn : parentByDepth.get(depth - 1) ?? header.top_pn;
    const key = `${depth}|${parent_pn}|`;
    let alt_of_pn = "";
    if (rec.find.includes("-")) {
      // 4-1 是 Find Num 4 的替代料
      alt_of_pn = findNumToPn.get(key + rec.find.split("-")[0]) ?? "";
    } else {
      findNumToPn.set(key + rec.find, rec.pn);
    }

    rows.push({
      line,
      values: {
        part_pn: rec.pn,
        // 主料料號一律記 BOM 最上層的組件（跟原本 Excel 的寫法一致），
        // 實際的上一階另外存在 parent_pn，才不會跟 Excel 匯入的同一顆料重複
        main_pn: header.top_pn,
        fg_model: header.top_desc,
        fg_desc: header.top_desc,
        part_desc: join(rec.desc),
        supplier: join(rec.mfr),
        bom_level: String(depth),
        parent_pn,
        find_num: rec.find,
        alt_of_pn,
        qty: rec.qty,
        ref_des: join(rec.refdes),
      },
      issues: [],
      notes: [],
    });
  }

  if (!rows.length) throw new BomPdfError("這個 PDF 裡沒有任何料號");
  return { header, rows, warnings };
}

const join = (parts: string[]) => parts.join(" ").replace(/\s+/g, " ").trim();

function readHeader(raw: { y: number; bits: TextBit[] }[]): PdfHeader {
  const text = (l: (typeof raw)[number]) => l.bits.map((b) => b.s).join(" ");
  const h: PdfHeader = { top_pn: "", top_desc: "", lifecycle: "", revision: "", change: "" };
  for (const l of raw.slice(0, 12)) {
    const t = text(l);
    const pn = l.bits[0]?.s ?? "";
    if (!h.top_pn && /^\d{3}-[A-Z0-9]{4}-\d{3}/i.test(pn)) {
      h.top_pn = pn;
      h.lifecycle = l.bits.slice(1).map((b) => b.s).join(" ").trim();
    } else if (/^Revision/.test(t)) {
      h.revision = (t.match(/Revision\s*•?\s*([^\s]+)/) ?? [])[1] ?? "";
      h.change = (t.match(/\b([A-Z]{2,4}-\d{4,})\b/) ?? [])[1] ?? "";
    } else if (t.includes("•") && !h.top_desc && !/^Revision/.test(t)) {
      h.top_desc = t.slice(t.indexOf("•") + 1).trim();
    }
  }
  return h;
}
