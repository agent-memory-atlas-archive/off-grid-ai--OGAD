import { C as ClipboardBridge, a as ClipboardRead, b as ClipboardItem } from '../types-hjEscIvQ.mjs';

/** Minimal shape of Electron's nativeImage instances we use. */
interface ElectronImage {
    isEmpty(): boolean;
    toPNG(): Buffer;
}
/** Minimal shape of Electron's clipboard module we use. */
interface ElectronClipboard {
    availableFormats(): string[];
    readImage(): ElectronImage;
    readRTF(): string;
    readText(): string;
    readBuffer(format: string): Buffer;
    read(format: string): string;
    writeText(text: string): void;
    writeRTF(text: string): void;
    writeImage(image: ElectronImage): void;
}
/** Minimal shape of Electron's nativeImage module we use. */
interface ElectronNativeImage {
    createFromBuffer(buffer: Buffer): ElectronImage;
}
declare class ElectronClipboardBridge implements ClipboardBridge {
    private readonly clipboard;
    private readonly nativeImage;
    constructor(clipboard: ElectronClipboard, nativeImage: ElectronNativeImage);
    private reference;
    private resolving;
    read(): ClipboardRead | null;
    write(item: ClipboardItem): void;
    private extract;
    private extractFile;
    /** Resolved path for a Finder reference URL, PENDING while osascript runs, or null
     *  for a normal URL. Only the current clipboard URL is cached. */
    private resolveReference;
}

export { type ElectronClipboard, ElectronClipboardBridge, type ElectronNativeImage };
