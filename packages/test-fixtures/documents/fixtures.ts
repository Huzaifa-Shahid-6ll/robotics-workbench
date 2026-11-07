/** Synthetic PDF objects; no vendor datasheet, measurements or reviewed electrical facts. */
export function pdfFixture(options: { rotated?: boolean; imageOnly?: boolean; encrypted?: boolean; activeContent?: boolean } = {}): Uint8Array {
  const literal = (s: string) => `(${s.replace(/[\\()]/g, '\\$&')})`;
  const table = 'BT /F1 12 Tf 20 260 Td (Supply table) Tj 0 -20 Td (Min 3.0   Max 5.5) Tj 0 -20 Td (Footnote: variant A only) Tj ET';
  const image = Buffer.alloc(16 * 16 * 3, 255);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if ([1, 7, 14].includes(y) || [1, 7, 14].includes(x)) image.fill(0, (y * 16 + x) * 3, (y * 16 + x) * 3 + 3);
  const stream = options.imageOnly ? 'q 160 0 0 160 20 100 cm /Scan Do Q' : table;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /S /D /St 10 >>] >> ${options.activeContent ? `/OpenAction << /S /JavaScript /JS ${literal('globalThis.pdfInstructionExecuted = true; fetch("https://untrusted.invalid/source")')} >>` : ''} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Rotate ${options.rotated ? 90 : 0} /Resources << /Font << /F1 5 0 R >> /XObject << /Scan 6 0 R >> >> /Contents 4 0 R ${options.activeContent ? '/Annots [7 0 R]' : ''} >>`,
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.length} >>\nstream\n`), image, Buffer.from('\nendstream')]),
    '<< /Type /Annot /Subtype /Link /Rect [10 10 30 30] /A << /S /URI /URI (https://untrusted.invalid/linked) >> >>',
    '<< /Filter /Standard /V 1 /R 2 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>',
  ];
  const pieces: Buffer[] = [Buffer.from('%PDF-1.7\n%synthetic\n')];
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pieces.reduce((n, piece) => n + piece.length, 0));
    pieces.push(Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(objects[i]) ? objects[i] as Buffer : Buffer.from(objects[i] as string), Buffer.from('\nendobj\n'));
  }
  const xref = pieces.reduce((n, piece) => n + piece.length, 0);
  pieces.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${options.encrypted ? '/Encrypt 8 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]' : ''} >>\nstartxref\n${xref}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(pieces));
}
