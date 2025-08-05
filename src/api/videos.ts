import { rm } from "fs/promises";
import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import path from "path";
import crypto from "crypto";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId)
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("This is not your video!");
  }

  const data = await req.formData();
  const uploadedVideo = data.get("video");
  if ((uploadedVideo instanceof File) === false) { 
    throw new BadRequestError("Video missing");
  }

  const MAX_UPLOAD_SIZE = 1 << 30;
  if (uploadedVideo.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(
      `Video file exceeds the maximum allowed size of 1GB`,
    );
  }

  const type = uploadedVideo.type;
  if (!type) {
    throw new BadRequestError("Missing Content-Type for video");
  }
  if (["video/mp4"].includes(type) === false) {
    throw new BadRequestError("Unsupported media type");
  }

  const ext = type.split("/")[1];
  const rand = crypto.randomBytes(32).toString("base64url");
  const filePath = path.join("/tmp/", `${rand}.${ext}`);

  await Bun.write(filePath, uploadedVideo);
 
  const aspectRatio = await getVideoAspectRatio(filePath);
  const processedFilePath = await processVideoForFastStart(filePath);
  const key = `${aspectRatio}/${videoId}.mp4`;
  const tmpFile = await Bun.file(processedFilePath);
  const s3File = cfg.s3Client.file(key, { bucket: cfg.s3Bucket });
  
  await s3File.write(tmpFile, { "type": type });

  video.videoURL = `https://d2twgibmhybzzr.cloudfront.net/${key}`;
  updateVideo(cfg.db, video);
  
  await Promise.all([
    rm(filePath, { force: true }),
    rm(`${filePath}.processed.mp4`, { force: true }),
  ]);

  return respondWithJSON(200, null);
}

export async function getVideoAspectRatio(filePath: string) {
  const process = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const outputText = await new Response(process.stdout).text();
  const errorText = await new Response(process.stderr).text();

  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe error: ${errorText}`);
  }

  const output = JSON.parse(outputText);
  if (!output.streams || output.streams.length === 0) {
    throw new Error("No video streams found");
  }

  const { width, height } = output.streams[0];

  return width === Math.floor(16 * (height / 9))
    ? "landscape"
    : height === Math.floor(16 * (width / 9))
      ? "portrait"
      : "other";
}

export async function processVideoForFastStart(inputFilePath: string) {
  const processedFilePath = `${inputFilePath}.processed.mp4`;

  const process = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      inputFilePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      processedFilePath,
    ],
    { stderr: "pipe" },
  );

  const errorText = await new Response(process.stderr).text();
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`FFmpeg error: ${errorText}`);
  }

  return processedFilePath;
}
