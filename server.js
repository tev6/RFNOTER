const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getNotesFile(userId) {
    return path.join(DATA_DIR, `notes_${userId}.json`);
}

app.get('/api/notes/:userId', (req, res) => {
    const filePath = getNotesFile(req.params.userId);
    if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8');
        res.json(JSON.parse(data));
    } else {
        res.json([]);
    }
});

app.post('/api/notes/:userId', (req, res) => {
    const filePath = getNotesFile(req.params.userId);
    fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2), 'utf-8');
    res.json({ success: true });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = app.listen(PORT, () => {
    console.log(`RFNOTER server running at http://localhost:${PORT}`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        const fallbackPort = PORT + 1;
        console.warn(`Port ${PORT} is in use, trying ${fallbackPort}...`);
        app.listen(fallbackPort, () => {
            console.log(`RFNOTER server running at http://localhost:${fallbackPort}`);
        });
    } else {
        console.error('Server error:', err);
    }
});
