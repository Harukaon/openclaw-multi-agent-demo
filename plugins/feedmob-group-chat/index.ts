import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { feedmobGroupChatPlugin } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "feedmob-group-chat",
  name: "FeedMob Group Chat",
  description: "A group-scoped multi-Agent chat channel backed by the FeedMob demo platform.",
  plugin: feedmobGroupChatPlugin,
});
