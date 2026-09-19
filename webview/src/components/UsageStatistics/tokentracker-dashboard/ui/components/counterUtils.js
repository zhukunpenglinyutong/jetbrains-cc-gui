export function getCounterPlaces(displayValue) {
  const source = String(displayValue ?? "");
  const chars = Array.from(source);
  const decimalIndex = chars.indexOf(".");
  let digitsBeforeDecimal = chars.filter(
    (char, index) => /\d/.test(char) && (decimalIndex === -1 || index < decimalIndex),
  ).length;
  let decimalPlaces = 0;
  let pastDecimal = false;

  return chars.map((char) => {
    if (!/\d/.test(char)) {
      if (char === ".") pastDecimal = true;
      return char;
    }

    if (!pastDecimal) {
      const place = 10 ** Math.max(digitsBeforeDecimal - 1, 0);
      digitsBeforeDecimal -= 1;
      return place;
    }

    decimalPlaces += 1;
    return 10 ** -decimalPlaces;
  });
}
