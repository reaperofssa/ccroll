const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const crypto = require('crypto');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = 7860;

function getRealisticUserAgent() {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

async function setupSpoofing(page, userAgent) {
  await page.evaluateOnNewDocument(() => {
    delete navigator.__proto__.webdriver;
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' }
      ]
    });
    if (!window.chrome) {
      window.chrome = { runtime: {} };
    }
  });
}

async function verifyLogin(email, password) {
  console.log('🔄 Launching browser...');
  
  const userAgent = getRealisticUserAgent();
  const siteKey = '6LeQj_wUAAAAABLdMxMxFF-x3Jvyd1hkbsRV9UAk';
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
      `--user-agent=${userAgent}`
    ],
    ignoreDefaultArgs: ['--enable-automation']
  });

  try {
    const page = await browser.newPage();
    await setupSpoofing(page, userAgent);
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(userAgent);

    console.log('📍 Navigating to SSO login...');
    await page.goto('https://sso.crunchyroll.com/login', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('🔐 Attempting login...');
    
    const loginResult = await page.evaluate(async (loginData) => {
      try {
        // Load reCAPTCHA
        await new Promise((resolve, reject) => {
          if (window.grecaptcha?.ready) {
            resolve();
            return;
          }
          
          const script = document.createElement('script');
          script.src = `https://www.google.com/recaptcha/api.js?render=${loginData.siteKey}`;
          
          let resolved = false;
          script.onload = () => {
            const checkReady = setInterval(() => {
              if (window.grecaptcha?.ready && !resolved) {
                resolved = true;
                clearInterval(checkReady);
                setTimeout(resolve, 1000);
              }
            }, 100);
            
            setTimeout(() => {
              if (!resolved) {
                clearInterval(checkReady);
                reject(new Error('reCAPTCHA timeout'));
              }
            }, 20000);
          };
          
          script.onerror = () => reject(new Error('Failed to load reCAPTCHA'));
          document.head.appendChild(script);
        });

        // Get reCAPTCHA token
        const recaptchaToken = await new Promise((resolve, reject) => {
          grecaptcha.ready(async () => {
            try {
              const token = await grecaptcha.execute(loginData.siteKey, { action: 'login' });
              resolve(token);
            } catch (error) {
              reject(error);
            }
          });
        });

        // Perform login
        const response = await fetch('https://sso.crunchyroll.com/api/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            email: loginData.email,
            password: loginData.password,
            recaptchaToken: recaptchaToken,
            eventSettings: {}
          }),
          credentials: 'include'
        });
        
        const data = await response.json();
        
        return {
          status: response.status,
          ok: response.ok,
          data: data
        };
      } catch (error) {
        return {
          error: error.message,
          stack: error.stack
        };
      }
    }, { email, password, siteKey });
    
    console.log('📊 Login response:', JSON.stringify(loginResult));
    
    // Check if login was successful
    if (loginResult.error) {
      return {
        success: false,
        valid: false,
        message: 'Login request failed',
        error: loginResult.error
      };
    }
    
    if (loginResult.status === 200 && loginResult.ok) {
      // Check the response data
      if (loginResult.data.status === 'ok') {
        console.log('✅ Login successful - credentials are valid');
        return {
          success: true,
          valid: true,
          message: 'Email and password are correct',
          email: email
        };
      } else {
        console.log('❌ Login failed - invalid credentials');
        return {
          success: true,
          valid: false,
          message: 'Invalid email or password',
          email: email
        };
      }
    } else if (loginResult.status === 401 || loginResult.status === 403) {
      console.log('❌ Login failed - invalid credentials');
      return {
        success: true,
        valid: false,
        message: 'Invalid email or password',
        email: email,
        details: loginResult.data
      };
    } else {
      console.log('⚠️ Unexpected response:', loginResult.status);
      return {
        success: true,
        valid: false,
        message: 'Login failed',
        email: email,
        statusCode: loginResult.status,
        details: loginResult.data
      };
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    return {
      success: false,
      valid: false,
      message: 'Error during login verification',
      error: error.message
    };
  } finally {
    await browser.close();
  }
}

app.get('/login', async (req, res) => {
  const { email, password } = req.query;

  if (!email || !password) {
    return res.status(200).json({
      success: false,
      valid: false,
      message: 'Missing email or password in query parameters'
    });
  }

  try {
    console.log(`\n🚀 Login verification for: ${email}`);
    console.log(`⏰ ${new Date().toISOString()}`);
    
    const result = await verifyLogin(email, password);

    res.status(200).json(result);

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(200).json({
      success: false,
      valid: false,
      message: 'Server error during verification',
      error: error.message
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'Crunchyroll Login Verification API',
    description: 'Verifies if email/password combination is valid',
    usage: 'GET /login?email=YOUR_EMAIL&password=YOUR_PASSWORD',
    response: {
      success: 'true if request completed, false if error',
      valid: 'true if credentials are correct, false if incorrect',
      message: 'Human-readable message',
      email: 'The email that was checked'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 http://localhost:${PORT}/login?email=YOUR_EMAIL&password=YOUR_PASSWORD`);
  console.log(`✅ Simple login verification - no token exchange`);
});
