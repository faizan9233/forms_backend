const express = require('express');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const cors =require('cors')
const app = express();
app.use(bodyParser.json());

app.use(cors())
const SCOPES = ['https://www.googleapis.com/auth/forms.body', 'https://www.googleapis.com/auth/forms.responses.readonly'];
const TOKEN_PATH = path.join(__dirname, 'token.json');




const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:3002/oauth2callback'
);


function ensureAuthenticated(req, res, next) {
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oAuth2Client.setCredentials(token);
    
    if (token.expiry_date <= Date.now()) {
      oAuth2Client.refreshAccessToken((err, newTokens) => {
        if (err) {
          console.error('Error refreshing access token:', err);
          return res.redirect('/auth');
        }
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(newTokens));
        oAuth2Client.setCredentials(newTokens);
        next();
      });
    } else {
      next();
    }
  } else {
    res.redirect('/auth');
  }
}


app.get('/auth', (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  res.redirect(authUrl);
});


app.get('/oauth2callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    res.send('Authorization complete! You can now create forms.');
  } catch (error) {
    console.error('Error retrieving access token', error);
    res.status(500).send('Authentication failed.');
  }
});

const forms = google.forms({ version: 'v1', auth: oAuth2Client });


app.get('/export-form/:formId', ensureAuthenticated, async (req, res) => {
  const formId = req.params.formId;
  console.log('Attempting to export form with ID:', formId); 
  try {
    const form = await forms.forms.get({ formId });
    const formData = form.data;
    fs.writeFileSync(`form-${formId}.json`, JSON.stringify(formData, null, 2));
    res.send(formData);
  } catch (error) {
    console.error('Error exporting form:', error.response?.data || error.message);
    res.status(500).send('Error exporting form');
  }
});


app.post('/import-form', ensureAuthenticated, async (req, res) => {
  const formJson = req.body;

  // Validate the incoming data structure
  if (!formJson || !formJson.info || !Array.isArray(formJson.items)) {
    return res.status(400).send('Invalid form JSON structure.');
  }

  const createRequestBody = {
    info: {
      title: formJson.info.title || 'Untitled Form',
      documentTitle: formJson.info.documentTitle || 'Untitled Form',
    },
  };

  try {
    const newForm = await forms.forms.create({ requestBody: createRequestBody });
    const formId = newForm.data.formId;

    const requests = [];
    const pageBreakIds = {};

    // Create page breaks first
    formJson.items.forEach((item) => {
      if (item.pageBreakItem) {
        requests.push({
          createItem: {
            item: {
              title: item.title,
              pageBreakItem: item.pageBreakItem,
            },
            location: { index: requests.length }, 
          },
        });
      }
    });

    // Process and create questions in the order they appear
    for (const item of formJson.items) {
      if (item.questionItem) {
        const options = item.questionItem.question.choiceQuestion.options.map((option) => ({
          value: option.value,
          goToSectionId: pageBreakIds[option.goToSectionId],
        }));

        requests.push({
          createItem: {
            item: {
              title: item.title,
              questionItem: {
                question: {
                  choiceQuestion: {
                    type: "RADIO",
                    options: options,
                  },
                },
              },
            },
            location: { index: requests.length }, 
          },
        });
      }
    }

    // Only call batchUpdate if there are requests
    if (requests.length > 0) {
      await forms.forms.batchUpdate({
        formId: formId,
        requestBody: { requests: requests },
      });
    }

    const response = await forms.forms.get({ formId: formId });
    response.data.items.forEach(item => {
      if (item.pageBreakItem) {
        pageBreakIds[item.title] = item.itemId; 
      }
    });

    // Construct the Google Form link
    const formLink = `https://docs.google.com/forms/d/${formId}/viewform`;

    // Send the form ID and link in the response
    res.send(formLink);
  } catch (error) {
    console.error('Error creating form:', error);
    res.status(500).send('Error creating form');
  }
});


app.get("/", (req, res) => {
  res.send("<h1>🚀 Server is Running ...</h1>");
});


const PORT = 3002;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
