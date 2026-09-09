// Decode only JSON string literals and JSON rows from Next's embedded Flight data.
// No eval, page JavaScript execution, private endpoints or auth state is needed.
export function flightObjects($) {
  const chunks = [];
  $("script").each((_i, node) => {
    for (const match of $(node)
      .text()
      .matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g))
      chunks.push(JSON.parse(match[1]));
  });
  const objects = [];
  function visit(value) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") {
      objects.push(value);
      Object.values(value).forEach(visit);
    }
  }
  // Flight T/binary rows use UTF-8 byte lengths, not newline termination.
  // Skipping by line would lose the JSON row immediately after a long description.
  const data = Buffer.from(chunks.join(""), "utf8");
  let offset = 0;
  while (offset < data.length) {
    const colon = data.indexOf(58, offset);
    if (colon < 0 || !/^[a-f0-9]*$/.test(data.toString("utf8", offset, colon))) break;
    offset = colon + 1;
    const tag = String.fromCharCode(data[offset]);
    if ("TAOoUSsLlGgMmV".includes(tag)) {
      const comma = data.indexOf(44, offset + 1);
      if (comma < 0) break;
      const sizeHex = data.toString("utf8", offset + 1, comma);
      if (!/^[a-f0-9]+$/.test(sizeHex)) break;
      const end = comma + 1 + Number.parseInt(sizeHex, 16);
      if (end > data.length) break;
      offset = end;
      continue;
    }
    const end = data.indexOf(10, offset);
    if (end < 0) break;
    const row = data.toString("utf8", offset, end);
    offset = end + 1;
    if (!row.startsWith("[") && !row.startsWith("{")) continue;
    let value;
    try {
      value = JSON.parse(row);
    } catch {
      continue;
    }
    visit(value);
  }
  return objects;
}
