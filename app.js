const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

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

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min);
}

async function verifyLogin(email, password) {
  console.log('🔄 Launching browser...');
  
  const userAgent = getRealisticUserAgent();
  
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

    // Listen for network requests to capture login response and token
    let loginResponse = null;
    let tokenData = null;
    let tokenRequest = null;
    
    page.on('response', async (response) => {
      const url = response.url();
      
      // Capture login response
      if (url.includes('/api/login') || url.includes('sso.crunchyroll.com/api')) {
        try {
          const status = response.status();
          const data = await response.json();
          loginResponse = { status, data, ok: response.ok() };
          console.log('📡 Intercepted login response:', { status, data });
        } catch (e) {
          console.log('⚠️ Could not parse login response:', e.message);
        }
      }
      
      // Capture token endpoint
      if (url.includes('crunchyroll.com/auth/v1/token')) {
        try {
          const status = response.status();
          const headers = {};
          response.headers().forEach((value, key) => {
            headers[key] = value;
          });
          const data = await response.json();
          tokenData = { 
            status, 
            headers,
            data, 
            ok: response.ok() 
          };
          console.log('🎫 Intercepted token response:', { status });
        } catch (e) {
          console.log('⚠️ Could not parse token response:', e.message);
        }
      }
    });
    
    page.on('request', (request) => {
      const url = request.url();
      
      // Capture token request details
      if (url.includes('crunchyroll.com/auth/v1/token')) {
        tokenRequest = {
          url: url,
          method: request.method(),
          headers: request.headers(),
          postData: request.postData()
        };
        console.log('📤 Token request intercepted');
      }
    });

    console.log('📍 Navigating to SSO login...');
    await page.goto('https://sso.crunchyroll.com/login', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Wait for the login form to load - use multiple selectors as fallback
    console.log('⏳ Waiting for login form...');
    await Promise.race([
      page.waitForSelector('input[name="email"]', { timeout: 10000 }),
      page.waitForSelector('input[type="email"]', { timeout: 10000 })
    ]);
    console.log('✅ Login form loaded');

    await new Promise(resolve => setTimeout(resolve, randomDelay(1000, 2000)));

    console.log('✍️ Typing email...');
    // Try multiple selectors for email field (most reliable first)
    const emailSelectors = [
      'input[name="email"]',
      'input[type="email"]',
      'input.email-input__field--H4fRW',
      '#email'
    ];
    
    let emailTyped = false;
    for (const selector of emailSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          await page.click(selector);
          await new Promise(resolve => setTimeout(resolve, randomDelay(100, 300)));
          await page.type(selector, email, { delay: randomDelay(50, 150) });
          emailTyped = true;
          console.log(`✅ Email typed using selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!emailTyped) {
      throw new Error('Could not find email input field');
    }

    await new Promise(resolve => setTimeout(resolve, randomDelay(500, 1000)));

    console.log('🔐 Typing password...');
    // Try multiple selectors for password field
    const passwordSelectors = [
      'input[name="password"]',
      'input[type="password"]',
      'input.password-input__field--Qgoe0',
      '#password'
    ];
    
    let passwordTyped = false;
    for (const selector of passwordSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          await page.click(selector);
          await new Promise(resolve => setTimeout(resolve, randomDelay(100, 300)));
          await page.type(selector, password, { delay: randomDelay(50, 150) });
          passwordTyped = true;
          console.log(`✅ Password typed using selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!passwordTyped) {
      throw new Error('Could not find password input field');
    }

    await new Promise(resolve => setTimeout(resolve, randomDelay(800, 1500)));

    console.log('🖱️ Clicking login button...');
    // Try multiple selectors for submit button
    const buttonSelectors = [
      'button[type="submit"]',
      'button.button--is-type-one--3uIzT',
      'button:has-text("Log In")',
      'form button[type="submit"]',
      'button.button--xqVd0'
    ];
    
    let buttonClicked = false;
    for (const selector of buttonSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          await page.click(selector);
          buttonClicked = true;
          console.log(`✅ Login button clicked using selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!buttonClicked) {
      throw new Error('Could not find login button');
    }

    // Wait for either redirect or error
    console.log('⏳ Waiting for login response...');
    
    // Wait for initial navigation to complete (max 15 seconds)
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null),
      new Promise(resolve => setTimeout(resolve, 15000))
    ]);

    let currentUrl = page.url();
    console.log('📍 Current URL after login:', currentUrl);

    // Check if we're on callback page - wait for redirect to discover
    if (currentUrl.includes('/callback')) {
      console.log('⏳ On callback page, waiting for redirect to discover...');
      
      try {
        // Wait for navigation away from callback (max 15 seconds)
        await Promise.race([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
          page.waitForFunction(
            () => !window.location.href.includes('/callback'),
            { timeout: 15000 }
          )
        ]);
        
        // Give page a moment to settle
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        currentUrl = page.url();
        console.log('✅ Redirected from callback to:', currentUrl);
      } catch (e) {
        console.log('⚠️ Timeout waiting for redirect from callback:', e.message);
      }
    }

    // If not yet on discover, wait a bit more for token request and potential redirect
    if (!currentUrl.includes('/discover')) {
      console.log('⏳ Not on discover yet, waiting for token request...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    const finalUrl = page.url();
    console.log('📍 Final URL:', finalUrl);

    // Check if redirected to discover page (successful login)
    if (finalUrl.includes('crunchyroll.com/discover') || 
        (finalUrl.includes('crunchyroll.com') && !finalUrl.includes('sso.crunchyroll.com'))) {
      console.log('✅ Login successful - on Crunchyroll');
      
      const result = {
        success: true,
        valid: true,
        message: 'Email and password are correct',
        email: email,
        redirectUrl: finalUrl
      };

      // Add token data if captured
      if (tokenData) {
        console.log('🎫 Token data captured');
        result.token = {
          access_token: tokenData.data.access_token,
          refresh_token: tokenData.data.refresh_token,
          expires_in: tokenData.data.expires_in,
          token_type: tokenData.data.token_type,
          scope: tokenData.data.scope,
          country: tokenData.data.country,
          account_id: tokenData.data.account_id,
          profile_id: tokenData.data.profile_id
        };
        
        result.tokenMetadata = {
          status: tokenData.status,
          headers: tokenData.headers
        };
      }

      // Add token request details if captured
      if (tokenRequest) {
        console.log('📤 Token request details captured');
        result.tokenRequest = {
          url: tokenRequest.url,
          method: tokenRequest.method,
          headers: tokenRequest.headers,
          body: tokenRequest.postData
        };
      }

      return result;
    }

    // Check intercepted login response
    if (loginResponse) {
      if (loginResponse.status === 200 && loginResponse.ok) {
        if (loginResponse.data.status === 'ok' || loginResponse.data.success) {
          console.log('✅ Login successful via API response');
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
      } else if (loginResponse.status === 401 || loginResponse.status === 403) {
        console.log('❌ Login failed - invalid credentials');
        return {
          success: true,
          valid: false,
          message: 'Invalid email or password',
          email: email
        };
      }
    }

    // Check for error messages on the page
    const errorElement = await page.$('.error, .error-message, [class*="error"]').catch(() => null);
    if (errorElement) {
      const errorText = await page.evaluate(el => el.textContent, errorElement);
      console.log('❌ Error on page:', errorText);
      return {
        success: true,
        valid: false,
        message: 'Invalid email or password',
        email: email,
        error: errorText
      };
    }

    // If still on login page, likely failed
    if (currentUrl.includes('sso.crunchyroll.com/login')) {
      console.log('⚠️ Still on login page - likely invalid credentials');
      return {
        success: true,
        valid: false,
        message: 'Invalid email or password',
        email: email
      };
    }

    console.log('⚠️ Unclear result');
    return {
      success: false,
      valid: false,
      message: 'Unable to determine login status',
      email: email,
      currentUrl: currentUrl
    };

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
    description: 'Verifies if email/password combination is valid using browser automation',
    usage: 'GET /login?email=YOUR_EMAIL&password=YOUR_PASSWORD',
    response: {
      success: 'true if request completed, false if error',
      valid: 'true if credentials are correct, false if incorrect',
      message: 'Human-readable message',
      email: 'The email that was checked'
    },
    method: 'Stealth browser automation with click & type'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 http://localhost:${PORT}/login?email=YOUR_EMAIL&password=YOUR_PASSWORD`);
  console.log(`✅ Stealth login verification using browser automation`);
});
