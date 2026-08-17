import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest { return { name: "雅思语境记忆", short_name: "语境记忆", description: "个人化雅思词汇与阅读学习工具", start_url: "/", display: "standalone", background_color: "#f5f7f4", theme_color: "#287b70", icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }] }; }
