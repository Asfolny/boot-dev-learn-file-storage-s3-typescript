import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import { getInMemoryURL } from "./assets";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
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
  const thumbnail = data.get("thumbnail");
  if ((thumbnail instanceof File) === false) { 
    throw new BadRequestError("Thumbnail missing");
  }

  const MAX_UPLOAD_SIZE = 10 << 20;
  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(
      `Thumbnail file exceeds the maximum allowed size of 10MB`,
    );
  }
  
  const type = thumbnail.type;
  if (!type) {
    throw new BadRequestError("Missing Content-Type for thumbnail");
  }

  const arrBuff = await thumbnail.arrayBuffer();
  if (!arrBuff) {
    throw new Error("Error reading file data");
  }

  const buff = Buffer.from(arrBuff);
  if (!buff) {
    throw new Error("Error converting from ArrayBuffer to Buffer");
  }

  const based = buff.toString("base64")
  
  const url = `data:${type};base64,${based}`;
  
  video.thumbnailURL = url;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
