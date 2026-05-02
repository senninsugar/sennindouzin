const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

app.use(express.static('.'));

app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json({ result: [] });

    try {
        const response = await axios.get(`https://momon-ga.com/?s=${encodeURIComponent(query)}`, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
                'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8'
            }
        });
        const html = response.data;
        const results = [];
        
        // 修正：個別のarticleをまず分割して取得し、その中からデータを抜き出す（より確実な方法）
        const articleBlocks = html.match(/<article[\s\S]*?<\/article>/g);
        
        if (articleBlocks) {
            articleBlocks.forEach(block => {
                // ID (URLから抽出)
                const idMatch = block.match(/href="https:\/\/momon-ga\.com\/fanzine\/(.*?)\/"/);
                // 画像URL (data-src や src 両方に対応)
                const imgMatch = block.match(/src="([^"]+)"/);
                // タイトル (h2内のテキスト)
                const titleMatch = block.match(/entry-title">[\s\S]*?>(.*?)<\/a>/);

                if (idMatch && imgMatch && titleMatch) {
                    results.push({
                        id: idMatch[1].replace(/\/$/, ""), 
                        image: imgMatch[1],
                        title: titleMatch[1].replace(/<[^>]*>?/gm, '').trim(),
                        rule: "" 
                    });
                }
            });
        }

        console.log(`Query: ${query}, Found: ${results.length} items`);
        res.json({ result: results });
    } catch (error) {
        console.error("Search API Error:", error.message);
        res.status(500).json({ error: "Search failed" });
    }
});

app.get('/api/proxy-details', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("URL is required");

    try {
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const htmlString = response.data;
        const imgUrls = [];
        
        const galleryRegex = /src="([^"]*galleries[^"]*)"/g;
        let match;
        while ((match = galleryRegex.exec(htmlString)) !== null) {
            let src = match[1];
            if (src.startsWith('/')) src = 'https://momon-ga.com' + src;
            imgUrls.push(`/api/image-proxy?url=${encodeURIComponent(src)}`);
        }

        const uniqueUrls = [...new Set(imgUrls)];
        const titleMatch = htmlString.match(/<h1[^>]*>(.*?)<\/h1>/);
        const title = titleMatch ? titleMatch[1].replace(/<[^>]*>?/gm, '').trim() : "No Title";

        res.json({ title, images: uniqueUrls });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch details" });
    }
});

app.get('/api/image-proxy', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send("Image URL is required");

    try {
        const response = await axios({
            method: 'get',
            url: imageUrl,
            responseType: 'stream',
            headers: { 
                'Referer': 'https://momon-ga.com/', 
                'User-Agent': 'Mozilla/5.0' 
            }
        });
        res.setHeader('Content-Type', response.headers['content-type']);
        response.data.pipe(res);
    } catch (error) {
        res.status(500).send("Image proxy error");
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
