import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

// The vanilla humanoid UV layout is authored in 64 logical pixels. Brand agent
// textures use an 8x raster so the visible 8x8 face can carry a clean logo.
const LOGICAL_SIZE = 64;
const BRAND_TEXTURE_SCALE = 8;
let TEXTURE_SCALE = BRAND_TEXTURE_SCALE;
let WIDTH = LOGICAL_SIZE * TEXTURE_SCALE;
let HEIGHT = LOGICAL_SIZE * TEXTURE_SCALE;
const CHANNELS = 4;
const EXPECTED_VARIANT_COUNT = 4;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TEXTURE_PREFIX = 'mineagen:textures/entity/';
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '..');
const MANIFEST_PATH = path.join(
	PROJECT_DIRECTORY,
	'src',
	'main',
	'resources',
	'assets',
	'mineagen',
	'identity',
	'agent_visual_manifest.json',
);
const OUTPUT_DIRECTORY = path.join(
	PROJECT_DIRECTORY,
	'src',
	'main',
	'resources',
	'assets',
	'mineagen',
	'textures',
	'entity',
);

// These are deterministic, nearest-neighbour pixel interpretations of each official
// mark. Keep the body colour dominant so the identity reads clearly at Minecraft's
// normal camera distance. The existing provider keys remain the source of truth for
// filenames.
const BRAND_PALETTES = Object.freeze({
	openai: Object.freeze({
		base: Object.freeze([16, 163, 127, 255]),
		dark: Object.freeze([8, 75, 59, 255]),
		light: Object.freeze([232, 255, 247, 255]),
		accent: Object.freeze([255, 255, 255, 255]),
	}),
	claude: Object.freeze({
		base: Object.freeze([217, 119, 87, 255]),
		dark: Object.freeze([107, 47, 34, 255]),
		light: Object.freeze([255, 224, 209, 255]),
		accent: Object.freeze([246, 176, 132, 255]),
	}),
});

// These are compressed RGBA rasterizations of the referenced brand marks rather
// than runtime downloads, so generation remains deterministic and the mod has
// no network dependency. Each mark uses a 56px raster inside the 64px face UV
// square.
const BRAND_LOGO_RASTER_SIZE = 56;
const BRAND_LOGO_RASTERS = Object.freeze({
	openai: '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',
	claude: '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',
});

const BRAND_TEXTURE_NAMES = Object.freeze(Object.keys(BRAND_PALETTES).flatMap((brand) =>
	Array.from({ length: EXPECTED_VARIANT_COUNT }, (_, variantIndex) => ({
		providerKey: `brand-${brand}`,
		providerIndex: -1,
		familyKey: brand,
		familyIndex: 0,
		variantIndex,
		textureName: `brand_${brand}_agent_${variantIndex}.png`,
		brandKey: brand,
	}))));

const CUBOID_FACES = Object.freeze([
	[8, 0, 8, 8], [16, 0, 8, 8], [0, 8, 8, 8], [8, 8, 8, 8], [16, 8, 8, 8], [24, 8, 8, 8],
	[20, 16, 8, 4], [28, 16, 8, 4], [16, 20, 4, 12], [20, 20, 8, 12], [28, 20, 4, 12], [32, 20, 8, 12],
	[44, 16, 4, 4], [48, 16, 4, 4], [40, 20, 4, 12], [44, 20, 4, 12], [48, 20, 4, 12], [52, 20, 4, 12],
	[4, 16, 4, 4], [8, 16, 4, 4], [0, 20, 4, 12], [4, 20, 4, 12], [8, 20, 4, 12], [12, 20, 4, 12],
	[20, 48, 4, 4], [24, 48, 4, 4], [16, 52, 4, 12], [20, 52, 4, 12], [24, 52, 4, 12], [28, 52, 4, 12],
	[36, 48, 4, 4], [40, 48, 4, 4], [32, 52, 4, 12], [36, 52, 4, 12], [40, 52, 4, 12], [44, 52, 4, 12],
]);

function loadOutputs() {
	const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
	if (manifest.schemaVersion !== 1) throw new Error('Manifest schemaVersion must be 1');
	const expected = new Set(BRAND_TEXTURE_NAMES.map(output => TEXTURE_PREFIX + output.textureName));
	const declared = manifest.brandSkins?.flatMap(brand => brand.variants.map(variant => variant.texturePath)) ?? [];
	if (declared.length !== expected.size || new Set(declared).size !== expected.size
			|| declared.some(texture => !expected.has(texture))) throw new Error('Manifest must declare only OpenAI and Claude brand textures');
	for (const provider of manifest.providers) {
		for (const family of provider.families) {
			if (family.variants.length !== EXPECTED_VARIANT_COUNT) throw new Error('Every model family needs four variants');
			for (const variant of family.variants) {
				if (!expected.has(variant.texturePath)) throw new Error('Model family references a removed skin');
			}
		}
	}
	return BRAND_TEXTURE_NAMES;
}

function createPixels() {
	return Buffer.alloc(WIDTH * HEIGHT * CHANNELS);
}

function setTexturePixel(pixels, x, y, color) {
	if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
	const offset = ((y * WIDTH) + x) * CHANNELS;
	for (let channel = 0; channel < CHANNELS; channel += 1) pixels[offset + channel] = color[channel];
}

function setPixel(pixels, x, y, color) {
	const scaledX = x * TEXTURE_SCALE;
	const scaledY = y * TEXTURE_SCALE;
	for (let pixelY = scaledY; pixelY < scaledY + TEXTURE_SCALE; pixelY += 1) {
		for (let pixelX = scaledX; pixelX < scaledX + TEXTURE_SCALE; pixelX += 1) {
			if (pixelX < 0 || pixelX >= WIDTH || pixelY < 0 || pixelY >= HEIGHT) continue;
			setTexturePixel(pixels, pixelX, pixelY, color);
		}
	}
}

function fillRect(pixels, x, y, width, height, color) {
	for (let row = y; row < y + height; row += 1) {
		for (let column = x; column < x + width; column += 1) setPixel(pixels, column, row, color);
	}
}

function visualBrandFor(output) {
	return output.brandKey;
}

function drawBrandBase(pixels, palette, variantIndex, familyIndex = 0) {
	for (const [x, y, width, height] of CUBOID_FACES) fillRect(pixels, x, y, width, height, palette.base);
	for (const [x, y, width, height] of [
		[0, 8, 8, 8], [16, 8, 8, 8], [16, 20, 4, 12], [28, 20, 4, 12],
		[40, 20, 4, 12], [48, 20, 4, 12], [0, 20, 4, 12], [8, 20, 4, 12],
		[16, 52, 4, 12], [24, 52, 4, 12], [32, 52, 4, 12], [40, 52, 4, 12],
	]) fillRect(pixels, x, y, width, height, palette.dark);
	// Variant marks are deliberately tiny and stay below the face logo.
	const accentX = variantIndex % 2 === 0 ? 20 : 32;
	const accentY = 30 + Math.floor(variantIndex / 2);
	fillRect(pixels, accentX, accentY, 8, 1, palette.accent);
	// Family accents retain deterministic uniqueness for legacy model families
	// while the brand mark remains identical across every family.
	if (familyIndex > 0) fillRect(pixels, 20 + (familyIndex * 2), 42, 2, 1, palette.light);
}

function blendLogoPixel(pixels, x, y, colour, alpha) {
	if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
	if (alpha === 0) return;
	if (alpha === 255) {
		setTexturePixel(pixels, x, y, colour);
		return;
	}
	const offset = ((y * WIDTH) + x) * CHANNELS;
	const inverse = 255 - alpha;
	const blended = [0, 0, 0, 255];
	for (let channel = 0; channel < 3; channel += 1) {
		blended[channel] = Math.round(((pixels[offset + channel] * inverse) + (colour[channel] * alpha)) / 255);
	}
	setTexturePixel(pixels, x, y, blended);
}

function logoColour(brand, source) {
	return [255, 255, 255, 255];
}

function drawLogoRaster(pixels, brand, originX, originY) {
	const raster = inflateSync(Buffer.from(BRAND_LOGO_RASTERS[brand], 'base64'));
	const rasterSize = BRAND_LOGO_RASTER_SIZE;
	const expectedLength = rasterSize * rasterSize * CHANNELS;
	if (raster.length !== expectedLength) throw new Error(`Invalid ${brand} logo raster length`);
	const faceSize = 8 * TEXTURE_SCALE;
	const offsetX = originX * TEXTURE_SCALE + Math.floor((faceSize - rasterSize) / 2);
	const offsetY = originY * TEXTURE_SCALE + Math.floor((faceSize - rasterSize) / 2);
	for (let row = 0; row < rasterSize; row += 1) {
		for (let column = 0; column < rasterSize; column += 1) {
			const sourceOffset = ((row * rasterSize) + column) * CHANNELS;
			const alpha = raster[sourceOffset + 3];
			blendLogoPixel(pixels, offsetX + column, offsetY + row, logoColour(brand, [
				raster[sourceOffset], raster[sourceOffset + 1], raster[sourceOffset + 2], 255,
			]), alpha);
		}
	}
}

function drawBrandLogo(pixels, brand) {
	// Keep the source logo on the front face only. Torso decals make the mark read
	// like a repeated texture rather than an agent identity.
	drawLogoRaster(pixels, brand, 8, 8);
}

function renderBrandSkin(output) {
	const brand = visualBrandFor(output);
	const palette = BRAND_PALETTES[brand];
	if (!palette) throw new Error(`No skin palette for ${brand}`);
	const pixels = createPixels();
	drawBrandBase(pixels, palette, output.variantIndex, output.familyIndex);
	drawBrandLogo(pixels, brand);
	return pixels;
}

function renderSkin(output) {
	const previousScale = TEXTURE_SCALE;
	const previousWidth = WIDTH;
	const previousHeight = HEIGHT;
	TEXTURE_SCALE = BRAND_TEXTURE_SCALE;
	WIDTH = LOGICAL_SIZE * TEXTURE_SCALE;
	HEIGHT = LOGICAL_SIZE * TEXTURE_SCALE;
	try {
		return {
			pixels: renderBrandSkin(output),
			width: WIDTH,
			height: HEIGHT,
		};
	} finally {
		TEXTURE_SCALE = previousScale;
		WIDTH = previousWidth;
		HEIGHT = previousHeight;
	}
}

function encodePng(pixels, width, height) {
	const scanlines = Buffer.alloc((width * CHANNELS + 1) * height);
	for (let y = 0; y < height; y += 1) {
		const rowStart = y * (width * CHANNELS + 1);
		scanlines[rowStart] = 0;
		pixels.copy(scanlines, rowStart + 1, y * width * CHANNELS, (y + 1) * width * CHANNELS);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([
		PNG_SIGNATURE,
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(scanlines, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function chunk(type, data) {
	const typeBuffer = Buffer.from(type, 'ascii');
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
	return Buffer.concat([length, typeBuffer, data, checksum]);
}

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function validateIhdr(buffer, expectedWidth, expectedHeight) {
	if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'not a PNG';
	if (buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') return 'has no leading IHDR';
	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	const bitDepth = buffer[24];
	const colorType = buffer[25];
	const compression = buffer[26];
	const filter = buffer[27];
	const interlace = buffer[28];
	if (width !== expectedWidth || height !== expectedHeight || bitDepth !== 8 || colorType !== 6
			|| compression !== 0 || filter !== 0 || interlace !== 0) {
		return `has IHDR ${width}x${height}, bitDepth=${bitDepth}, colorType=${colorType}, compression=${compression}, filter=${filter}, interlace=${interlace}`;
	}
	return null;
}

function checkOutputs(outputs) {
	const errors = [];
	const expectedNames = new Set(outputs.map((output) => output.textureName));
	const actualNames = existsSync(OUTPUT_DIRECTORY)
		? readdirSync(OUTPUT_DIRECTORY).filter((name) => name.endsWith('.png')).sort()
		: [];
	if (actualNames.length !== outputs.length) {
		errors.push(`output count drift: manifest=${outputs.length}, directory=${actualNames.length}`);
	}
	for (const actualName of actualNames) {
		if (!expectedNames.has(actualName)) errors.push(`obsolete output: ${actualName}`);
	}

	const providerBuffers = new Map();
	for (const output of outputs) {
		const outputPath = path.join(OUTPUT_DIRECTORY, output.textureName);
		if (!existsSync(outputPath)) {
			errors.push(`missing output: ${output.textureName}`);
			continue;
		}
		const actual = readFileSync(outputPath);
		const expectedScale = BRAND_TEXTURE_SCALE;
		const ihdrError = validateIhdr(actual, LOGICAL_SIZE * expectedScale, LOGICAL_SIZE * expectedScale);
		if (ihdrError) errors.push(`${output.textureName} ${ihdrError}`);
		const rendered = renderSkin(output);
		const expected = encodePng(rendered.pixels, rendered.width, rendered.height);
		if (!actual.equals(expected)) errors.push(`non-deterministic or stale output: ${output.textureName}`);
		const previous = providerBuffers.get(output.providerKey) ?? [];
		for (const candidate of previous) {
			if (actual.equals(candidate.buffer)) {
				errors.push(`duplicate ${output.providerKey} texture bytes: ${candidate.name} and ${output.textureName}`);
			}
		}
		previous.push({ name: output.textureName, buffer: actual });
		providerBuffers.set(output.providerKey, previous);
	}

	if (errors.length > 0) {
		for (const error of errors) process.stderr.write(`ERROR: ${error}\n`);
		throw new Error(`Agent skin check failed with ${errors.length} error(s)`);
	}
	process.stdout.write(`Validated ${outputs.length} manifest-driven agent textures (${BRAND_TEXTURE_SCALE}x branded).\n`);
}

function writeOutputs(outputs) {
	mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
	const expectedNames = new Set(outputs.map((output) => output.textureName));
	for (const output of outputs) {
		const rendered = renderSkin(output);
		writeFileSync(path.join(OUTPUT_DIRECTORY, output.textureName),
			encodePng(rendered.pixels, rendered.width, rendered.height));
	}
	process.stdout.write(`Generated ${outputs.length} manifest-driven agent textures.\n`);
}

const outputs = loadOutputs();
if (process.argv.slice(2).includes('--check')) {
	checkOutputs(outputs);
} else {
	writeOutputs(outputs);
}
