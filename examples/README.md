# TapBook 示例：Monsters on Wheels

这是一个 17 页的互动绘本样例，展示 TapBook 阅读器如何保留原书页面，并加入主题舞台、点词发音、词义提示、逐句高亮和中英朗读。

![Monsters on Wheels 互动绘本预览](monsters-on-wheels-preview.png)

## 本地打开

1. 下载并解压 [`monsters-on-wheels-interactive.zip`](monsters-on-wheels-interactive.zip)。
2. 在解压目录启动静态 HTTP 服务：

   ```bash
   python3 -m http.server 8000
   ```

3. 在浏览器访问 `http://localhost:8000/`。

样例已经包含页面图片、阅读器代码和生成好的本地朗读音频。它不需要 TTS 后端；生成这份样例时用到的原始 PDF 不包含在压缩包中。

**内容授权：**《Monsters on Wheels》的原书页面、文字和相关绘本素材仅作为经授权公开的演示样例提供，不属于 TapBook 的 PolyForm Noncommercial 许可。请查看 [`SAMPLE-CONTENT-NOTICE.txt`](SAMPLE-CONTENT-NOTICE.txt)；TapBook 代码的非商业许可不授予原书内容的复制、改编或商业使用权。若单独转发样例 ZIP，请同时附上该内容说明和 [`TAPBOOK-LICENSE.txt`](TAPBOOK-LICENSE.txt)，以保留许可边界。
