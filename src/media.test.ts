import { describe, expect, it } from "vitest";
import { asrArgsFor, isMediaFile, MEDIA_EXTENSIONS } from "./media.mjs";

describe("isMediaFile", () => {
  it("recognises the audio and video docling reads", () => {
    for (const name of ["talk.mp3", "meeting.mp4", "call.wav", "clip.mov", "x.m4a"]) {
      expect(isMediaFile(name), name).toBe(true);
    }
  });

  it("leaves documents alone", () => {
    for (const name of ["report.pdf", "notes.md", "deck.pptx", "scan.png"]) {
      expect(isMediaFile(name), name).toBe(false);
    }
  });

  it("does not care about case, and tolerates a path", () => {
    expect(isMediaFile("/tmp/x/TALK.MP3")).toBe(true);
  });

  it("says no for a name with no extension", () => {
    expect(isMediaFile("recording")).toBe(false);
  });

  it("lists its extensions so /health can report them", () => {
    expect(MEDIA_EXTENSIONS).toContain("mp3");
    expect(MEDIA_EXTENSIONS).toContain("mp4");
  });
});

describe("asrArgsFor", () => {
  // Transcription is only attempted on media, so a document never pays for a
  // model it does not need.
  it("adds nothing for a document", () => {
    expect(asrArgsFor("report.pdf", {})).toEqual({});
    expect(asrArgsFor("report.pdf", { asrModel: "whisper-tiny" })).toEqual({});
  });

  it("passes the caller's model and language through for media", () => {
    expect(asrArgsFor("talk.mp3", { asrModel: "whisper-small", asrLang: "de" })).toEqual({
      asrModel: "whisper-small",
      asrLang: "de",
    });
  });

  it("falls back to the configured default model when the caller named none", () => {
    expect(asrArgsFor("talk.mp3", {}, { defaultModel: "whisper-tiny" })).toEqual({
      asrModel: "whisper-tiny",
    });
  });

  it("adds nothing when there is no default and no caller choice", () => {
    expect(asrArgsFor("talk.mp3", {})).toEqual({});
  });

  it("keeps videoFrames only for video", () => {
    expect(asrArgsFor("clip.mp4", { videoFrames: 8 })).toMatchObject({ videoFrames: 8 });
    expect(asrArgsFor("talk.mp3", { videoFrames: 8 }).videoFrames).toBeUndefined();
  });
});
