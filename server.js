const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// CORS設定
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// 静的ファイルの提供 (Renderデプロイ用)
app.use(express.static('.'));

// 画像をBase64に変換する関数
async function getBase64(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const contentType = response.headers['content-type'];
        const base64 = Buffer.from(response.data, 'binary').toString('base64');
        return `data:${contentType};base64,${base64}`;
    } catch (e) {
        return null;
    }
}

// スクレイピング & Base64一括変換エンドポイント
app.get('/api/proxy-base64', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("URL is required");

    try {
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const htmlString = response.data;

        // サーバーサイドで簡易的に画像URLを抽出
        const imgUrls = [];
        const galleryRegex = /src="([^"]*galleries[^"]*)"/g;
        let match;
        while ((match = galleryRegex.exec(htmlString)) !== null) {
            let src = match[1];
            if (src.startsWith('/')) src = 'https://momon-ga.com' + src;
            imgUrls.push(src);
        }

        // 重複削除
        const uniqueUrls = [...new Set(imgUrls)];

        // 全画像をBase64に変換 (並列処理)
        const base64Images = await Promise.all(uniqueUrls.map(url => getBase64(url)));
        
        // タイトル抽出 (簡易)
        const titleMatch = htmlString.match(/<h1>(.*?)<\/h1>/);
        const title = titleMatch ? titleMatch[1] : "No Title";

        res.json({
            title: title,
            images: base64Images.filter(img => img !== null)
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch and convert images" });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
