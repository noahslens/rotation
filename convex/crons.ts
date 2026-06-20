import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "delete expired playlists",
  { minutes: 10 },
  internal.playlistExpirationActions.deleteExpiredPlaylists,
  {},
);

export default crons;
