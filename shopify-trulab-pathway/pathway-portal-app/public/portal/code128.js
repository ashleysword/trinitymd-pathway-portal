// Code 128 decoder carried over from the earlier PATHWAY customer portal
// (photographed kit labels were Code 128 B). Used when BarcodeDetector is unavailable.
(function pathwayCode128(global) {
  'use strict';

  const CODE128_PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
    '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
    '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
    '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
    '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
    '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
    '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
    '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
    '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
    '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
    '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
    '211214', '211232', '2331112',
  ].map((pattern) => [...pattern].map(Number));

  function patternScore(runs, pattern) {
    const runTotal = runs.reduce((sum, value) => sum + value, 0);
    const patternTotal = pattern.reduce((sum, value) => sum + value, 0);
    return runs.reduce((sum, value, index) => {
      const difference = value / runTotal - pattern[index] / patternTotal;
      return sum + difference * difference;
    }, 0);
  }

  function decodeCode128Values(values) {
    if (values.length < 3 || ![103, 104, 105].includes(values[0])) return null;
    const suppliedChecksum = values.at(-1);
    const calculated = values.slice(1, -1)
      .reduce((sum, value, index) => sum + value * (index + 1), values[0]);
    if (calculated % 103 !== suppliedChecksum) return null;

    let codeSet = { 103: 'A', 104: 'B', 105: 'C' }[values[0]];
    let shift = null;
    let output = '';

    for (const value of values.slice(1, -1)) {
      const activeSet = shift || codeSet;
      shift = null;
      if (value === 98) {
        shift = codeSet === 'A' ? 'B' : 'A';
      } else if (value === 99) {
        codeSet = 'C';
      } else if (value === 100) {
        codeSet = 'B';
      } else if (value === 101) {
        codeSet = 'A';
      } else if (value === 102) {
        continue;
      } else if (activeSet === 'C' && value <= 99) {
        output += String(value).padStart(2, '0');
      } else if (activeSet === 'B' && value <= 95) {
        output += String.fromCharCode(value + 32);
      } else if (activeSet === 'A' && value <= 63) {
        output += String.fromCharCode(value + 32);
      } else if (activeSet === 'A' && value <= 95) {
        output += String.fromCharCode(value - 64);
      } else {
        return null;
      }
    }
    return output;
  }

  function runsFromDarkPixels(darkPixels) {
    const colors = [];
    const runs = [];
    let last = darkPixels[0];
    let count = 1;
    for (let index = 1; index < darkPixels.length; index += 1) {
      if (darkPixels[index] === last) {
        count += 1;
      } else {
        colors.push(last);
        runs.push(count);
        last = darkPixels[index];
        count = 1;
      }
    }
    colors.push(last);
    runs.push(count);
    return { colors, runs };
  }

  function decodeRuns(colors, runs) {
    for (let startIndex = 0; startIndex < runs.length - 20; startIndex += 1) {
      if (!colors[startIndex]) continue;
      const startCandidates = [103, 104, 105]
        .map((value) => ({
          value,
          score: patternScore(runs.slice(startIndex, startIndex + 6), CODE128_PATTERNS[value]),
        }))
        .sort((left, right) => left.score - right.score);
      if (startCandidates[0].score > 0.012) continue;

      const values = [startCandidates[0].value];
      let position = startIndex + 6;
      for (let symbol = 0; symbol < 80; symbol += 1) {
        if (position + 7 <= runs.length
          && patternScore(runs.slice(position, position + 7), CODE128_PATTERNS[106]) < 0.01) {
          const decoded = decodeCode128Values(values);
          if (decoded) return decoded;
          break;
        }
        if (position + 6 > runs.length) break;

        let best = { value: -1, score: Number.POSITIVE_INFINITY };
        for (let value = 0; value < 106; value += 1) {
          const score = patternScore(runs.slice(position, position + 6), CODE128_PATTERNS[value]);
          if (score < best.score) best = { value, score };
        }
        if (best.score > 0.012) break;
        values.push(best.value);
        position += 6;
      }
    }
    return null;
  }

  function decodeCode128Row(luminance) {
    if (!luminance || luminance.length < 120) return null;
    const sorted = [...luminance].sort((left, right) => left - right);
    const darkLevel = sorted[Math.floor(sorted.length * .08)];
    const lightLevel = sorted[Math.floor(sorted.length * .92)];
    if (lightLevel - darkLevel < 55) return null;
    const threshold = (darkLevel + lightLevel) / 2;

    const forward = luminance.map((value) => value < threshold);
    const firstAttempt = runsFromDarkPixels(forward);
    const decoded = decodeRuns(firstAttempt.colors, firstAttempt.runs);
    if (decoded) return decoded;

    const reverseAttempt = runsFromDarkPixels([...forward].reverse());
    return decodeRuns(reverseAttempt.colors, reverseAttempt.runs);
  }

  function decodeCode128ImageData(imageData) {
    const { data, width, height } = imageData;
    const top = Math.floor(height * .08);
    const bottom = Math.ceil(height * .92);
    const step = Math.max(2, Math.floor((bottom - top) / 52));
    for (let y = top; y < bottom; y += step) {
      const row = new Array(width);
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        row[x] = data[offset] * .299 + data[offset + 1] * .587 + data[offset + 2] * .114;
      }
      const decoded = decodeCode128Row(row);
      if (decoded) return decoded;
    }
    return null;
  }

  global.PathwayCode128Decoder = {
    decodeCode128ImageData,
    decodeCode128Row,
    decodeCode128Values,
    patterns: CODE128_PATTERNS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
