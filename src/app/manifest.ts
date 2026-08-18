import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest { return { name: "语境记忆", short_name: "语境记忆", description: "本地优先的语境词汇与间隔复习工具", start_url: "/", display: "standalone", background_color: "#f5f7f4", theme_color: "#287b70", icons: [{ src: "/brand/context-memory-logo.png", sizes: "1024x1024", type: "image/png" }] }; }
