let expression = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export let palette = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  inverse: "\x1b[7m",
};

let colorsEnabled = true;

export function setColorsEnabled(enabled) {
  colorsEnabled = enabled;
}

export function style(text, ...styles) {
  if (!colorsEnabled || !styles.length) return String(text);
  return `${styles.join("")}${text}${palette.reset}`;
}

export function stripAnsi(text) {
  return String(text).replace(expression, "");
}

export function visibleLength(text) {
  return Array.from(stripAnsi(text)).length;
}

export function truncateAnsi(text, width, suffix = "…") {
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;
  let suffixWidth = visibleLength(suffix);
  let target = Math.max(0, width - suffixWidth);
  let output = "";
  let visible = 0;
  let index = 0;
  while (index < text.length && visible < target) {
    if (text[index] === "\x1b") {
      let match = text.slice(index).match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
      if (match) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }
    let character = Array.from(text.slice(index))[0];
    output += character;
    index += character.length;
    visible += 1;
  }
  return `${output}${suffix}${colorsEnabled ? palette.reset : ""}`;
}

export function padAnsi(text, width, alignment = "left") {
  let clipped = truncateAnsi(text, width);
  let padding = Math.max(0, width - visibleLength(clipped));
  if (alignment === "right") return `${" ".repeat(padding)}${clipped}`;
  if (alignment === "center") {
    let left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
  }
  return `${clipped}${" ".repeat(padding)}`;
}

export function cleanText(value) {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function wrapText(value, width) {
  if (width <= 0) return [];
  let paragraphs = cleanText(value).split("\n");
  let lines = [];
  for (let paragraph of paragraphs) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let remaining = paragraph;
    while (Array.from(remaining).length > width) {
      let characters = Array.from(remaining);
      let candidate = characters.slice(0, width + 1).join("");
      let breakAt = candidate.lastIndexOf(" ");
      if (breakAt < Math.floor(width * 0.45)) breakAt = width;
      lines.push(candidate.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
}

export function box(title, width, height, rows, options = {}) {
  if (width < 4 || height < 3)
    return Array.from({ length: Math.max(0, height) }, () =>
      " ".repeat(Math.max(0, width)),
    );
  let borderStyle = options.focused ? palette.brightCyan : palette.gray;
  let topTitle = title ? ` ${title} ` : "";
  let topFill = Math.max(0, width - 2 - visibleLength(topTitle));
  let output = [style(`┌${topTitle}${"─".repeat(topFill)}┐`, borderStyle)];
  let innerWidth = width - 2;
  for (let index = 0; index < height - 2; index += 1) {
    let row = rows[index] ?? "";
    output.push(
      `${style("│", borderStyle)}${padAnsi(row, innerWidth)}${style("│", borderStyle)}`,
    );
  }
  output.push(style(`└${"─".repeat(width - 2)}┘`, borderStyle));
  return output;
}

export function joinColumns(columns) {
  let height = Math.max(0, ...columns.map((column) => column.length));
  let lines = [];
  for (let row = 0; row < height; row += 1) {
    lines.push(columns.map((column) => column[row] ?? "").join(""));
  }
  return lines;
}

export function overlay(base, modal, left, top) {
  let output = base.slice();
  for (let row = 0; row < modal.length; row += 1) {
    let target = top + row;
    if (target < 0 || target >= output.length) continue;
    let plain = stripAnsi(output[target]);
    let before = plain.slice(0, Math.max(0, left));
    let after = plain.slice(Math.max(0, left) + visibleLength(modal[row]));
    output[target] = `${before}${modal[row]}${after}`;
  }
  return output;
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  let totalSeconds = Math.floor(milliseconds / 1000);
  let hours = Math.floor(totalSeconds / 3600);
  let minutes = Math.floor((totalSeconds % 3600) / 60);
  let seconds = totalSeconds % 60;
  if (hours > 0)
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function writeScreen(lines, width, height) {
  let output = ["\x1b[H"];
  for (let row = 0; row < height; row += 1) {
    output.push("\x1b[2K", padAnsi(lines[row] ?? "", width));
    if (row < height - 1) output.push("\n");
  }
  process.stdout.write(output.join(""));
}

export function enterScreen() {
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
}

export function leaveScreen() {
  process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l");
}
