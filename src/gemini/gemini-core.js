import { OAuth2Client } from 'google-auth-library';
import * as http from 'http';
import * as https from 'https';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import open from 'open';
import { API_ACTIONS, formatExpiryTime } from '../common.js';
import { getProviderModels } from '../provider-models.js';
import { handleGeminiCliOAuth } from '../oauth-handlers.js';

// Configure HTTP/HTTPS agent to limit connection pool size and avoid resource leaks
const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 5,
    timeout: 120000,
});
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    maxFreeSockets: 5,
    timeout: 120000,
});

// --- Constants ---
const AUTH_REDIRECT_PORT = 8085;
const CREDENTIALS_DIR = '.gemini';
const CREDENTIALS_FILE = 'oauth_creds.json';
const DEFAULT_CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const DEFAULT_CODE_ASSIST_API_VERSION = 'v1internal';
const OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const GEMINI_MODELS = getProviderModels('gemini-cli-oauth');
const ANTI_TRUNCATION_MODELS = GEMINI_MODELS.map(model => `anti-${model}`);

function is_anti_truncation_model(model) {
    return ANTI_TRUNCATION_MODELS.some(antiModel => model.includes(antiModel));
}

// Extract actual model name from anti-truncation model name
function extract_model_from_anti_model(model) {
    if (model.startsWith('anti-')) {
        const originalModel = model.substring(5); // Remove 'anti-' prefix
        if (GEMINI_MODELS.includes(originalModel)) {
            return originalModel;
        }
    }
    return model; // If not anti-prefix or not in original model list, return original model name
}

function toGeminiApiResponse(codeAssistResponse) {
    if (!codeAssistResponse) return null;
    const compliantResponse = { candidates: codeAssistResponse.candidates };
    if (codeAssistResponse.usageMetadata) compliantResponse.usageMetadata = codeAssistResponse.usageMetadata;
    if (codeAssistResponse.promptFeedback) compliantResponse.promptFeedback = codeAssistResponse.promptFeedback;
    if (codeAssistResponse.automaticFunctionCallingHistory) compliantResponse.automaticFunctionCallingHistory = codeAssistResponse.automaticFunctionCallingHistory;
    return compliantResponse;
}

/**
 * Ensures that all content parts in a request body have a 'role' property.
 * If 'systemInstruction' is present and lacks a role, it defaults to 'user'.
 * If any 'contents' entry lacks a role, it defaults to 'user'.
 * @param {Object} requestBody - The request body object.
 * @returns {Object} The modified request body with roles ensured.
 */
function ensureRolesInContents(requestBody) {
    delete requestBody.model;
    // delete requestBody.system_instruction;
    // delete requestBody.systemInstruction;
    if (requestBody.system_instruction) {
        requestBody.systemInstruction = requestBody.system_instruction;
        delete requestBody.system_instruction;
    }

    if (requestBody.systemInstruction && !requestBody.systemInstruction.role) {
        requestBody.systemInstruction.role = 'user';
    }

    if (requestBody.contents && Array.isArray(requestBody.contents)) {
        requestBody.contents.forEach(content => {
            if (!content.role) {
                content.role = 'user';
            }
        });

        // If systemInstruction exists, place it at index 0 of contents
        // if (requestBody.systemInstruction) {
        //     // Check if contents[0] has the same content as systemInstruction
        //     const firstContent = requestBody.contents[0];
        //     let isSame = false;

        //     if (firstContent && firstContent.parts && requestBody.systemInstruction.parts) {
        //         // Compare the content of parts arrays
        //         const firstContentText = firstContent.parts
        //             .filter(p => p?.text)
        //             .map(p => p.text)
        //             .join('\n');
        //         const systemInstructionText = requestBody.systemInstruction.parts
        //             .filter(p => p?.text)
        //             .map(p => p.text)
        //             .join('\n');
                
        //         isSame = firstContentText === systemInstructionText;
        //     }

        //     // If content is different, insert systemInstruction at index 0
        //     if (!isSame) {
        //         requestBody.contents.unshift({
        //             role: requestBody.systemInstruction.role || 'user',
        //             parts: requestBody.systemInstruction.parts
        //         });
        //     }
        //     delete requestBody.systemInstruction;
        // }
    }
    return requestBody;
}

async function* apply_anti_truncation_to_stream(service, model, requestBody) {
    let currentRequest = { ...requestBody };
    let allGeneratedText = '';

    while (true) {
        // Send request and handle streaming response
        const apiRequest = {
            model: model,
            project: service.projectId,
            request: currentRequest
        };
        const stream = service.streamApi(API_ACTIONS.STREAM_GENERATE_CONTENT, apiRequest);

        let lastChunk = null;
        let hasContent = false;

        for await (const chunk of stream) {
            const response = toGeminiApiResponse(chunk.response);
            if (response && response.candidates && response.candidates[0]) {
                yield response;
                lastChunk = response;
                hasContent = true;
            }
        }

        // Check if truncated due to token limit
        if (lastChunk &&
            lastChunk.candidates &&
            lastChunk.candidates[0] &&
            lastChunk.candidates[0].finishReason === 'MAX_TOKENS') {

            // Extract generated text content
            if (lastChunk.candidates[0].content && lastChunk.candidates[0].content.parts) {
                const generatedParts = lastChunk.candidates[0].content.parts
                    .filter(part => part.text)
                    .map(part => part.text);

                if (generatedParts.length > 0) {
                    const currentGeneratedText = generatedParts.join('');
                    allGeneratedText += currentGeneratedText;

                    // Build new request with previous conversation history and continue instruction
                    const newContents = [...requestBody.contents];

                    // Add previously generated content as model response
                    newContents.push({
                        role: 'model',
                        parts: [{ text: currentGeneratedText }]
                    });

                    // Add continue instruction
                    newContents.push({
                        role: 'user',
                        parts: [{ text: 'Please continue from where you left off.' }]
                    });

                    currentRequest = {
                        ...requestBody,
                        contents: newContents
                    };

                    // Continue to next request
                    continue;
                }
            }
        }

        // If not truncated or cannot continue, exit loop
        break;
    }
}

export class GeminiApiService {
    constructor(config) {
        // Configure OAuth2Client to use custom HTTP agent
        this.authClient = new OAuth2Client({
            clientId: OAUTH_CLIENT_ID,
            clientSecret: OAUTH_CLIENT_SECRET,
            transporterOptions: {
                agent: httpsAgent,
            },
        });
        this.availableModels = [];
        this.isInitialized = false;

        this.config = config;
        this.host = config.HOST;
        this.oauthCredsBase64 = config.GEMINI_OAUTH_CREDS_BASE64;
        this.oauthCredsFilePath = config.GEMINI_OAUTH_CREDS_FILE_PATH;
        this.projectId = config.PROJECT_ID;

        this.codeAssistEndpoint = config.GEMINI_BASE_URL || DEFAULT_CODE_ASSIST_ENDPOINT;
        this.apiVersion = DEFAULT_CODE_ASSIST_API_VERSION;
    }

    async initialize() {
        if (this.isInitialized) return;
        console.log('[Gemini] Initializing Gemini API Service...');
        await this.initializeAuth();
        if (!this.projectId) {
            this.projectId = await this.discoverProjectAndModels();
        } else {
            console.log(`[Gemini] Using provided Project ID: ${this.projectId}`);
            this.availableModels = GEMINI_MODELS;
            console.log(`[Gemini] Using fixed models: [${this.availableModels.join(', ')}]`);
        }
        if (this.projectId === 'default') {
            throw new Error("Error: 'default' is not a valid project ID. Please provide a valid Google Cloud Project ID using the --project-id argument.");
        }
        this.isInitialized = true;
        console.log(`[Gemini] Initialization complete. Project ID: ${this.projectId}`);
    }

    async initializeAuth(forceRefresh = false) {
        if (this.authClient.credentials.access_token && !forceRefresh) return;

        if (this.oauthCredsBase64) {
            try {
                const decoded = Buffer.from(this.oauthCredsBase64, 'base64').toString('utf8');
                const credentials = JSON.parse(decoded);
                this.authClient.setCredentials(credentials);
                console.log('[Gemini Auth] Authentication configured successfully from base64 string.');
                return;
            } catch (error) {
                console.error('[Gemini Auth] Failed to parse base64 OAuth credentials:', error);
                throw new Error(`Failed to load OAuth credentials from base64 string.`);
            }
        }

        const credPath = this.oauthCredsFilePath || path.join(os.homedir(), CREDENTIALS_DIR, CREDENTIALS_FILE);
        try {
            const data = await fs.readFile(credPath, "utf8");
            const credentials = JSON.parse(data);
            this.authClient.setCredentials(credentials);
            console.log('[Gemini Auth] Authentication configured successfully from file.');
            
            if (forceRefresh) {
                console.log('[Gemini Auth] Forcing token refresh...');
                const { credentials: newCredentials } = await this.authClient.refreshAccessToken();
                this.authClient.setCredentials(newCredentials);
                // Save refreshed credentials back to file
                await fs.writeFile(credPath, JSON.stringify(newCredentials, null, 2));
                console.log('[Gemini Auth] Token refreshed and saved successfully.');
            }
        } catch (error) {
            console.error('[Gemini Auth] Error initializing authentication:', error.code);
            if (error.code === 'ENOENT' || error.code === 400) {
                console.log(`[Gemini Auth] Credentials file '${credPath}' not found. Starting new authentication flow...`);
                const newTokens = await this.getNewToken(credPath);
                this.authClient.setCredentials(newTokens);
                console.log('[Gemini Auth] New token obtained and loaded into memory.');
            } else {
                console.error('[Gemini Auth] Failed to initialize authentication from file:', error);
                throw new Error(`Failed to load OAuth credentials.`);
            }
        }
    }

    async getNewToken(credPath) {
        // Use unified OAuth handling method
        const { authUrl, authInfo } = await handleGeminiCliOAuth(this.config);
        
        console.log('\n[Gemini Auth] Opening browser automatically for authorization...');
        console.log('[Gemini Auth] Authorization link:', authUrl, '\n');

        // Open browser automatically
        const showFallbackMessage = () => {
            console.log('[Gemini Auth] Unable to open browser automatically, please manually copy the above link and open it in a browser');
        };

        if (this.config) {
            try {
                const childProcess = await open(authUrl);
                if (childProcess) {
                    childProcess.on('error', () => showFallbackMessage());
                }
            } catch (_err) {
                showFallbackMessage();
            }
        } else {
            showFallbackMessage();
        }

        // 等待 OAuth 回调完成并读取保存的凭据
        return new Promise((resolve, reject) => {
            const checkInterval = setInterval(async () => {
                try {
                    const data = await fs.readFile(credPath, 'utf8');
                    const credentials = JSON.parse(data);
                    if (credentials.access_token) {
                        clearInterval(checkInterval);
                        console.log('[Gemini Auth] New token obtained successfully.');
                        resolve(credentials);
                    }
                } catch (error) {
                    // 文件尚未创建或无效，继续等待
                }
            }, 1000);

            // 设置超时（5分钟）
            setTimeout(() => {
                clearInterval(checkInterval);
                reject(new Error('[Gemini Auth] OAuth 授权超时'));
            }, 5 * 60 * 1000);
        });
    }

    async discoverProjectAndModels() {
        if (this.projectId) {
            console.log(`[Gemini] Using pre-configured Project ID: ${this.projectId}`);
            return this.projectId;
        }

        console.log('[Gemini] Discovering Project ID...');
        this.availableModels = GEMINI_MODELS;
        console.log(`[Gemini] Using fixed models: [${this.availableModels.join(', ')}]`);
        try {
            const initialProjectId = ""
            // Prepare client metadata
            const clientMetadata = {
                ideType: "IDE_UNSPECIFIED",
                platform: "PLATFORM_UNSPECIFIED",
                pluginType: "GEMINI",
                duetProject: initialProjectId,
            }

            // Call loadCodeAssist to discover the actual project ID
            const loadRequest = {
                cloudaicompanionProject: initialProjectId,
                metadata: clientMetadata,
            }

            const loadResponse = await this.callApi('loadCodeAssist', loadRequest);

            // Check if we already have a project ID from the response
            if (loadResponse.cloudaicompanionProject) {
                return loadResponse.cloudaicompanionProject;
            }

            // If no existing project, we need to onboard
            const defaultTier = loadResponse.allowedTiers?.find(tier => tier.isDefault);
            const tierId = defaultTier?.id || 'free-tier';

            const onboardRequest = {
                tierId: tierId,
                cloudaicompanionProject: initialProjectId,
                metadata: clientMetadata,
            };

            let lroResponse = await this.callApi('onboardUser', onboardRequest);

            // Poll until operation is complete with timeout protection
            const MAX_RETRIES = 30; // Maximum number of retries (60 seconds total)
            let retryCount = 0;

            while (!lroResponse.done && retryCount < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                lroResponse = await this.callApi('onboardUser', onboardRequest);
                retryCount++;
            }

            if (!lroResponse.done) {
                throw new Error('Onboarding timeout: Operation did not complete within expected time.');
            }

            const discoveredProjectId = lroResponse.response?.cloudaicompanionProject?.id || initialProjectId;
            return discoveredProjectId;
        } catch (error) {
            console.error('[Gemini] Failed to discover Project ID:', error.response?.data || error.message);
            throw new Error('Could not discover a valid Google Cloud Project ID.');
        }
    }

    async listModels() {
        if (!this.isInitialized) await this.initialize();
        const formattedModels = this.availableModels.map(modelId => {
            const displayName = modelId.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
            return {
                name: `models/${modelId}`, version: "1.0.0", displayName: displayName,
                description: `A generative model for text and chat generation. ID: ${modelId}`,
                inputTokenLimit: 1024000, outputTokenLimit: 65535,
                supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
            };
        });
        return { models: formattedModels };
    }

    async callApi(method, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        try {
            const requestOptions = {
                url: `${this.codeAssistEndpoint}/${this.apiVersion}:${method}`,
                method: "POST",
                headers: { "Content-Type": "application/json" },
                responseType: "json",
                body: JSON.stringify(body),
            };
            const res = await this.authClient.request(requestOptions);
            return res.data;
        } catch (error) {
            console.error(`[API] Error calling ${method}:`, error.response?.status, error.message);

            // Handle 401 (Unauthorized) - refresh auth and retry once
            if ((error.response?.status === 400 || error.response?.status === 401) && !isRetry) {
                console.log('[API] Received 401/400. Refreshing auth and retrying...');
                await this.initializeAuth(true);
                return this.callApi(method, body, true, retryCount);
            }

            // Handle 429 (Too Many Requests) with exponential backoff
            if (error.response?.status === 429 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[API] Received 429 (Too Many Requests). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, body, isRetry, retryCount + 1);
            }

            // Handle other retryable errors (5xx server errors)
            if (error.response?.status >= 500 && error.response?.status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[API] Received ${error.response.status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, body, isRetry, retryCount + 1);
            }

            throw error;
        }
    }

    async * streamApi(method, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        try {
            const requestOptions = {
                url: `${this.codeAssistEndpoint}/${this.apiVersion}:${method}`,
                method: "POST",
                params: { alt: "sse" },
                headers: { "Content-Type": "application/json" },
                responseType: "stream",
                body: JSON.stringify(body),
            };
            const res = await this.authClient.request(requestOptions);
            if (res.status !== 200) {
                let errorBody = '';
                for await (const chunk of res.data) errorBody += chunk.toString();
                throw new Error(`Upstream API Error (Status ${res.status}): ${errorBody}`);
            }
            yield* this.parseSSEStream(res.data);
        } catch (error) {
            console.error(`[API] Error during stream ${method}:`, error.response?.status, error.message);

            // Handle 401 (Unauthorized) - refresh auth and retry once
            if ((error.response?.status === 400 || error.response?.status === 401) && !isRetry) {
                console.log('[API] Received 401/400 during stream. Refreshing auth and retrying...');
                await this.initializeAuth(true);
                yield* this.streamApi(method, body, true, retryCount);
                return;
            }

            // Handle 429 (Too Many Requests) with exponential backoff
            if (error.response?.status === 429 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[API] Received 429 (Too Many Requests) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(method, body, isRetry, retryCount + 1);
                return;
            }

            // Handle other retryable errors (5xx server errors)
            if (error.response?.status >= 500 && error.response?.status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[API] Received ${error.response.status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(method, body, isRetry, retryCount + 1);
                return;
            }

            throw error;
        }
    }

    async * parseSSEStream(stream) {
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let buffer = [];
        for await (const line of rl) {
            if (line.startsWith("data: ")) buffer.push(line.slice(6));
            else if (line === "" && buffer.length > 0) {
                try { yield JSON.parse(buffer.join('\n')); } catch (e) { console.error("[Stream] Failed to parse JSON chunk:", buffer.join('\n')); }
                buffer = [];
            }
        }
        if (buffer.length > 0) {
            try { yield JSON.parse(buffer.join('\n')); } catch (e) { console.error("[Stream] Failed to parse final JSON chunk:", buffer.join('\n')); }
        }
    }

    async generateContent(model, requestBody) {
        console.log(`[Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);
        let selectedModel = model;
        if (!GEMINI_MODELS.includes(model)) {
            console.warn(`[Gemini] Model '${model}' not found. Using default model: '${GEMINI_MODELS[0]}'`);
            selectedModel = GEMINI_MODELS[0];
        }
        const processedRequestBody = ensureRolesInContents(requestBody);
        const apiRequest = { model: selectedModel, project: this.projectId, request: processedRequestBody };
        const response = await this.callApi(API_ACTIONS.GENERATE_CONTENT, apiRequest);
        return toGeminiApiResponse(response.response);
    }

    async * generateContentStream(model, requestBody) {
        console.log(`[Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);

        // 检查是否为防截断模型
        if (is_anti_truncation_model(model)) {
            // 从防截断模型名中提取实际模型名
            const actualModel = extract_model_from_anti_model(model);
            // 使用防截断流处理
            const processedRequestBody = ensureRolesInContents(requestBody);
            yield* apply_anti_truncation_to_stream(this, actualModel, processedRequestBody);
        } else {
            // 正常流处理
            let selectedModel = model;
            if (!GEMINI_MODELS.includes(model)) {
                console.warn(`[Gemini] Model '${model}' not found. Using default model: '${GEMINI_MODELS[0]}'`);
                selectedModel = GEMINI_MODELS[0];
            }
            const processedRequestBody = ensureRolesInContents(requestBody);
            const apiRequest = { model: selectedModel, project: this.projectId, request: processedRequestBody };
            const stream = this.streamApi(API_ACTIONS.STREAM_GENERATE_CONTENT, apiRequest);
            for await (const chunk of stream) {
                yield toGeminiApiResponse(chunk.response);
            }
        }
    }

     /**
     * Checks if the given expiry date is within the next 10 minutes from now.
     * @returns {boolean} True if the expiry date is within the next 10 minutes, false otherwise.
     */
    isExpiryDateNear() {
        try {
            const currentTime = Date.now();
            const cronNearMinutesInMillis = (this.config.CRON_NEAR_MINUTES || 10) * 60 * 1000;
            console.log(`[Gemini] Expiry date: ${this.authClient.credentials.expiry_date}, Current time: ${currentTime}, ${this.config.CRON_NEAR_MINUTES || 10} minutes from now: ${currentTime + cronNearMinutesInMillis}`);
            return this.authClient.credentials.expiry_date <= (currentTime + cronNearMinutesInMillis);
        } catch (error) {
            console.error(`[Gemini] Error checking expiry date: ${error.message}`);
            return false;
        }
    }

    /**
     * 获取模型配额信息
     * @returns {Promise<Object>} 模型配额信息
     */
    async getUsageLimits() {
        if (!this.isInitialized) await this.initialize();
        
        // 检查 token 是否即将过期，如果是则先刷新
        if (this.isExpiryDateNear()) {
            console.log('[Gemini] Token is near expiry, refreshing before getUsageLimits request...');
            await this.initializeAuth(true);
        }

        try {
            const modelsWithQuotas = await this.getModelsWithQuotas();
            return modelsWithQuotas;
        } catch (error) {
            console.error('[Gemini] Failed to get usage limits:', error.message);
            throw error;
        }
    }

    /**
     * 获取带配额信息的模型列表
     * @returns {Promise<Object>} 模型配额信息
     */
    async getModelsWithQuotas() {
        try {
            // 解析模型配额信息
            const result = {
                lastUpdated: Date.now(),
                models: {}
            };

            // 调用 retrieveUserQuota 接口获取用户配额信息
            try {
                const quotaURL = `${this.codeAssistEndpoint}/${this.apiVersion}:retrieveUserQuota`;
                const requestBody = {
                    project: `projects/${this.projectId}`
                };
                const requestOptions = {
                    url: quotaURL,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    responseType: 'json',
                    body: JSON.stringify(requestBody)
                };

                const res = await this.authClient.request(requestOptions);
                console.log(`[Gemini] retrieveUserQuota success`);
                if (res.data && res.data.buckets) {
                    const buckets = res.data.buckets;
                    
                    // 遍历 buckets 数组，提取配额信息
                    for (const bucket of buckets) {
                        const modelId = bucket.modelId;
                        
                        // 检查模型是否在支持的模型列表中
                        if (!GEMINI_MODELS.includes(modelId)) continue;
                        
                        const modelInfo = {
                            remaining: bucket.remainingFraction || 0,
                            resetTime: bucket.resetTime || null,
                            resetTimeRaw: bucket.resetTime
                        };
                        
                        result.models[modelId] = modelInfo;
                    }

                    // 对模型按名称排序
                    const sortedModels = {};
                    Object.keys(result.models).sort().forEach(key => {
                        sortedModels[key] = result.models[key];
                    });
                    result.models = sortedModels;
                    // console.log(`[Gemini] Sorted Models:`, sortedModels);
                    console.log(`[Gemini] Successfully fetched quotas for ${Object.keys(result.models).length} models`);
                }
            } catch (fetchError) {
                console.error(`[Gemini] Failed to fetch user quota:`, fetchError.message);
                
                // 如果 retrieveUserQuota 失败，回退到使用固定模型列表
                for (const modelId of GEMINI_MODELS) {
                    result.models[modelId] = {
                        remaining: 0,
                        resetTime: null,
                        resetTimeRaw: null
                    };
                }
            }

            return result;
        } catch (error) {
            console.error('[Gemini] Failed to get models with quotas:', error.message);
            throw error;
        }
    }
}
