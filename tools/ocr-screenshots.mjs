// OCR the divergence screenshot with portable tesseract (fas+eng) and find the
// symbol name + RSI/date evidence in it.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const dir = "/c/tmp/qa2/جدید";
const files = readdirSync(dir).filter((f) => f.endsWith(".png"));
const tesseract = "C:/tmp/tesseract-portable/tesseract.exe";
const tessdata = "C:/tmp/tesseract-portable/tessdata";

for (const f of files) {
  const full = `${dir}/${f}`;
  let out = "";
  try {
    out = execFileSync(tesseract, [full.replace(/\//g, "\\"), "stdout", "-l", "fas+eng", "--tessdata-dir", tessdata, "--psm", "6"], { encoding: "utf8", timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
  } catch (e) {
    console.log(`=== ${f} === OCR FAILED: ${e.message.slice(0, 80)}`);
    continue;
  }
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  console.log(`=== ${f} === (${lines.length} lines)`);
  for (const l of lines.slice(0, 40)) console.log("   ", l.slice(0, 110));
}
