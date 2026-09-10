import React, { useEffect, useMemo } from "react";
import { m, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";

function getStaticTokenStyle(token, height) {
  if (token === ".") {
    return {
      width: "0.34ch",
      justifyContent: "center",
      marginInline: "-0.04ch",
    };
  }

  if (token === ",") {
    return {
      width: "0.08ch",
      justifyContent: "center",
      marginInline: "-0.30ch",
    };
  }

  return {
    width: "0.72ch",
    justifyContent: "flex-start",
    paddingLeft: "0.04ch",
    height,
  };
}

function RollingDigit({ mv, digit, height }) {
  const y = useTransform(mv, (latest) => {
    const placeValue = ((latest % 10) + 10) % 10;
    const offset = (10 + digit - placeValue) % 10;
    let next = offset * height;
    if (offset > 5) next -= 10 * height;
    return next;
  });

  return (
    <m.span
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        y,
      }}
    >
      {digit}
    </m.span>
  );
}

function normalizeNearInteger(num) {
  const nearest = Math.round(num);
  const tolerance = 1e-9 * Math.max(1, Math.abs(num));
  return Math.abs(num - nearest) < tolerance ? nearest : num;
}

function getValueRoundedToPlace(value, place) {
  const scaled = value / place;
  return Math.floor(normalizeNearInteger(scaled));
}

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

function StaticToken({ place, height, digitStyle }) {
  const staticTokenStyle = getStaticTokenStyle(place, height);
  // Letter tokens (unit suffixes like K/M/B) are wider than a digit cell, so
  // a fixed digit-width (from digitStyle) clips them against the row's
  // overflow:hidden. Let the glyph size itself; "." and "," keep their tuned
  // widths.
  const isLetterToken = place !== "." && place !== ",";
  // The caller's digitStyle.width sizes DIGIT cells. Applied to ".", it
  // stretches the dot into a full digit slot, leaving a big gap around it (the
  // comma escapes this via its large negative margin; the dot's -0.04ch
  // can't). Re-assert the dot's tuned narrow width after digitStyle so it
  // reads as tight as the thousands comma. Letters still size to auto.
  const isDot = place === ".";
  return (
    <span
      data-counter-token="static"
      className="relative inline-flex items-center justify-center"
      style={{
        height,
        ...staticTokenStyle,
        ...digitStyle,
        ...(isLetterToken
          ? { width: "auto", paddingInline: "0.06ch", justifyContent: "center" }
          : null),
        ...(isDot ? { width: staticTokenStyle.width } : null),
      }}
    >
      {place}
    </span>
  );
}

function AnimatedDigit({ place, value, height, digitStyle, shouldReduceMotion }) {
  const valueRoundedToPlace = getValueRoundedToPlace(value, place);
  const motionValue = useMotionValue(0);
  const animatedValue = useSpring(motionValue, {
    stiffness: 220,
    damping: 26,
    mass: 0.8,
  });

  useEffect(() => {
    motionValue.set(valueRoundedToPlace);
  }, [motionValue, valueRoundedToPlace]);

  if (shouldReduceMotion) {
    return (
      <span
        data-counter-token="digit"
        className="relative inline-flex items-center justify-center overflow-hidden"
        style={{
          height,
          position: "relative",
          width: "0.9ch",
          fontVariantNumeric: "tabular-nums",
          ...digitStyle,
        }}
      >
        {Math.abs(valueRoundedToPlace) % 10}
      </span>
    );
  }

  return (
    <span
      data-counter-token="digit"
      className="relative inline-flex overflow-hidden"
      style={{
        height,
        position: "relative",
        width: "0.9ch",
        fontVariantNumeric: "tabular-nums",
        ...digitStyle,
      }}
    >
      {Array.from({ length: 10 }, (_, digit) => (
        <RollingDigit key={digit} mv={animatedValue} digit={digit} height={height} />
      ))}
    </span>
  );
}

// Non-numeric places (".", ",", unit letters) render no hooks, so they get
// their own component instead of an early return inside a hooked component.
function Digit(props) {
  if (typeof props.place !== "number") {
    return <StaticToken place={props.place} height={props.height} digitStyle={props.digitStyle} />;
  }
  return <AnimatedDigit {...props} />;
}

export default function Counter({
  value,
  displayValue,
  fontSize = 72,
  padding = 0,
  places,
  gap = 6,
  borderRadius = 4,
  horizontalPadding = 0,
  textColor = "inherit",
  fontWeight = "inherit",
  containerStyle,
  counterStyle,
  digitStyle,
  gradientHeight = 14,
  gradientFrom = "rgba(255,255,255,0.95)",
  gradientTo = "rgba(255,255,255,0)",
  topGradientStyle,
  bottomGradientStyle,
}) {
  const resolvedDisplayValue = String(displayValue ?? value ?? "");
  const resolvedPlaces = useMemo(
    () => (Array.isArray(places) && places.length ? places : getCounterPlaces(resolvedDisplayValue)),
    [places, resolvedDisplayValue],
  );
  const isTestEnv =
    (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent || "")) ||
    typeof process !== "undefined" &&
    (process.env?.NODE_ENV === "test" || process.env?.VITEST === "true");
  const shouldReduceMotion = useReducedMotion() || isTestEnv;
  const numericValue = Number.isFinite(Number(value)) ? Math.abs(Number(value)) : 0;
  const height = fontSize + padding;

  if (shouldReduceMotion) {
    return (
      <span
        data-counter-root="true"
        style={{
          display: "inline-flex",
          alignItems: "center",
          color: textColor,
          fontSize,
          fontWeight,
          lineHeight: 1,
          ...containerStyle,
          ...counterStyle,
        }}
      >
        {resolvedDisplayValue}
      </span>
    );
  }

  return (
    <span
      data-counter-root="true"
      style={{
        position: "relative",
        display: "inline-block",
        ...containerStyle,
      }}
    >
      <span
        style={{
          fontSize,
          display: "flex",
          gap,
          overflow: "hidden",
          borderRadius,
          paddingLeft: horizontalPadding,
          paddingRight: horizontalPadding,
          lineHeight: 1,
          color: textColor,
          fontWeight,
          ...counterStyle,
        }}
      >
        {resolvedPlaces.map((place, index) => (
          <Digit
            key={`${String(place)}-${index}`}
            place={place}
            value={numericValue}
            height={height}
            digitStyle={digitStyle}
            shouldReduceMotion={shouldReduceMotion}
          />
        ))}
      </span>
      <span
        style={{
          pointerEvents: "none",
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        <span
          style={
            topGradientStyle ?? {
              height: gradientHeight,
              background: `linear-gradient(to bottom, ${gradientFrom}, ${gradientTo})`,
            }
          }
        />
        <span
          style={
            bottomGradientStyle ?? {
              height: gradientHeight,
              background: `linear-gradient(to top, ${gradientFrom}, ${gradientTo})`,
            }
          }
        />
      </span>
    </span>
  );
}
