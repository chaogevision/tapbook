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
