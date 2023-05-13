import { PropertyBag, StringBuilder, Validator } from './core';
import * as vector from './embeddings';
import * as oai from './openai';
import * as oaiapi from 'openai';

export interface AgentEvent<T> {
    readonly seqNumber: number;
    readonly createDate: Date;
    lastUsed?: Date; // Last used is handy for relevancy
    data: T; // This can also be rewritten by the AI
}

export interface AgentEventStream<T> {
    count: number;
    append(data: T): void;
    allEvents(orderByNewest: boolean): IterableIterator<AgentEvent<T>>;
    // More methods for last N, filtering by dates etc.
}

//
// Very simple in-memory.. memory
// The events in this class are deliberately mutable
// This allows for easy experimentation with rewriting events, or compressing/merging
// past events, or creating synthetic events from existing ones
//
export class EventHistory<T> implements AgentEventStream<T> {
    private _history: AgentEvent<T>[]; // Always sorted by timestamp
    private _seqNumber: number;
    constructor() {
        this._history = [];
        this._seqNumber = 0;
    }

    public get count() {
        return this._history.length;
    }

    public get(index: number): AgentEvent<T> {
        return this._history[index];
    }

    public append(data: T): void {
        this._seqNumber++;
        this._history.push({
            seqNumber: this._seqNumber,
            createDate: new Date(),
            data: data,
        });
    }

    public *allEvents(orderByNewest = true): IterableIterator<AgentEvent<T>> {
        if (orderByNewest) {
            for (let i = this._history.length - 1; i >= 0; --i) {
                yield this._history[i];
            }
        } else {
            for (let i = 0; i < this._history.length; ++i) {
                yield this._history[i];
            }
        }
    }

    // Trim history by this much
    public trim(count: number): void {
        if (count >= this._history.length) {
            this._history.length = 0;
        } else {
            this._history.splice(0, count);
        }
    }
}

export enum MessageSourceType {
    AI,
    User,
}

export interface MessageSource {
    type: MessageSourceType;
    name?: string;
}

export interface Message {
    source: MessageSource;
    text: string;
    embedding?: vector.Embedding;
    properties?: PropertyBag;
}

export class ContextBuilder {
    private _sb: StringBuilder;
    private _maxLength: number;

    constructor(maxLength: number) {
        this._maxLength = maxLength;
        this._sb = new StringBuilder();
    }

    public get length() {
        return this._sb.length;
    }

    public get maxLength(): number {
        return this._maxLength;
    }
    public set maxLength(value: number) {
        Validator.greaterThan(value, 0, 'maxLength');
        this._maxLength = value;
    }

    public start(): void {
        this._sb.reset();
    }

    public append(value: string): boolean {
        if (!value) {
            return true;
        }
        if (this._sb.length + (value.length + 1) <= this._maxLength) {
            this._sb.appendLine(value);
            return true;
        }
        return false;
    }

    public appendMessage(chatMessage: Message): boolean {
        if (this.append(chatMessage.text)) {
            if (chatMessage.source.name) {
                return this.append(chatMessage.source.name);
            }
            return true;
        }
        return false;
    }

    public appendEvents(
        events: IterableIterator<AgentEvent<Message>>
    ): boolean {
        let result = true;
        for (const evt of events) {
            if (!this.appendMessage(evt.data)) {
                result = false;
                break;
            }
        }
        return result;
    }

    public complete(): string {
        this._sb.reverse();
        return this._sb.toString();
    }
}

export interface IChatPipeline {
    startingRequest?: (chat: Chat, message: Message) => Message;
    collectContext?: (
        chat: Chat,
        message: Message
    ) => Promise<string | undefined>;
    buildPrompt: (
        chat: Chat,
        message: Message,
        context?: string,
    ) => string | undefined;
    // Use this to retrieve cached responses...
    getResponse?: (chat: Chat, prompt: string) => Promise<string | undefined>;
    responseReceived?: (
        chat: Chat,
        message: Message,
        response: Message
    ) => Message;
    appendToHistory?: (chat: Chat, message: Message) => Promise<void>;
}

export class Chat {
    private _client: oai.OpenAIClient;
    private _model: oai.ModelSettings; // Model we are speaking with
    private _modelInfo?: oai.ModelInfo;
    private _pipeline?: IChatPipeline;
    private _properties: PropertyBag;

    constructor(
        client: oai.OpenAIClient,
        model: oai.ModelSettings,
        pipeline?: IChatPipeline
    ) {
        this._client = client;
        this._model = model;
        this._modelInfo = oai.getKnownModel(model.modelName);
        this._pipeline = pipeline;
        this._properties = {};
    }

    public get modelInfo(): oai.ModelInfo | undefined {
        return this._modelInfo;
    }
    public get client(): oai.OpenAIClient {
        return this._client;
    }
    public get pipeline(): IChatPipeline | undefined {
        return this._pipeline;
    }
    public set pipeline(pipeline: IChatPipeline | undefined) {
        this._pipeline = pipeline;
    }
    public get properties(): PropertyBag {
        return this._properties;
    }

    public async getCompletion(
        message: string,
        maxTokens: number,
        temperature: number
    ): Promise<string> {
        Validator.defined(message, 'message');
        const requestMessage: Message = {
            text: message,
            source: {
                type: MessageSourceType.User,
            },
        };
        const requestParams: oaiapi.CreateCompletionRequest = {
            model: '',
            prompt: '',
            max_tokens: maxTokens,
            temperature: temperature,
        };
        const responseMessage = await this.runCompletion(
            requestMessage,
            requestParams
        );
        return responseMessage.text;
    }

    public async runCompletion(
        requestMessage: Message,
        requestParams: oaiapi.CreateCompletionRequest
    ): Promise<Message> {

        // Pre-process message before sending
        requestMessage = await this.startingRequest(requestMessage);
        // Collect context to send to the AI
        const context = await this.collectContext(requestMessage);
        // Use message and context to build a prompt
        let prompt = this.buildPrompt(requestMessage, context);
        if (!prompt) {
            prompt = requestMessage.text;
        }
        requestParams.prompt = prompt;
        // Get a cached or canned response if one exists
        let responseText = await this.getResponse(prompt);
        if (!responseText) {
            // Lets get a fresh resposne
            responseText = await this._client.getTextCompletion(
                this._model,
                requestParams
            );
        }
        let responseMessage: Message = {
            source: {
                type: MessageSourceType.AI,
            },
            text: responseText,
        };
        // Post-process the response
        responseMessage = await this.onResponse(
            requestMessage,
            responseMessage
        );
        // Save to history
        await this.appendToHistory(requestMessage);
        await this.appendToHistory(responseMessage);
        return responseMessage;
    }

    protected startingRequest(message: Message): Message {
        if (this._pipeline?.startingRequest) {
            return this._pipeline.startingRequest(this, message);
        }
        return message;
    }
    protected async collectContext(
        message: Message
    ): Promise<string | undefined> {
        if (this._pipeline?.collectContext) {
            return await this._pipeline.collectContext(this, message);
        }
        return undefined;
    }
    protected buildPrompt(
        message: Message,
        context?: string
    ): string | undefined {
        if (this._pipeline?.buildPrompt) {
            return this._pipeline.buildPrompt(this, message, context);
        }
        return undefined;
    }
    protected async getResponse(prompt: string): Promise<string | undefined> {
        if (this._pipeline?.getResponse) {
            return await this._pipeline.getResponse(this, prompt);
        }
        return undefined;
    }
    protected onResponse(message: Message, response: Message): Message {
        if (this._pipeline?.responseReceived) {
            return this._pipeline.responseReceived(this, message, response);
        }
        return response;
    }
    protected async appendToHistory(message: Message): Promise<void> {
        if (this._pipeline?.appendToHistory) {
            await this._pipeline.appendToHistory(this, message);
        }
    }
}

export interface ChatSettings {
    promptStartBlock?: string;
    promptEndBlock?: string;
    userName?: string;
    botName?: string;
    chatModelName: string;
    embeddingGenerator?: vector.TextEmbeddingGenerator;
    embeddingModelName?: string;
    history?: AgentEventStream<Message>;
}

// Basic Chat Bot
export class ChatBot extends Chat {
    private _settings: ChatSettings;
    private _history: AgentEventStream<Message>;
    private _contextBuilder: ContextBuilder;
    private _embeddingsModel?: oai.ModelSettings;

    constructor(client: oai.OpenAIClient, settings: ChatSettings) {
        const modelSettings = client.models.resolveModel(
            settings.chatModelName
        );
        super(client, modelSettings!);
        this._settings = settings;
        if (this._settings.history) {
            this._history = this._settings.history;
        } else {
            this._history = new EventHistory<Message>();
        }
        this._contextBuilder = new ContextBuilder(256);
        if (settings.embeddingModelName) {
            this._embeddingsModel = client.models.resolveModel(
                settings.embeddingModelName
            );
        }
    }
    public get settings() {
        return this._settings;
    }
    public get history() {
        return this._history;
    }
    public get maxContextLength(): number {
        return this._contextBuilder.maxLength;
    }
    public set maxContextLength(value: number) {
        this._contextBuilder.maxLength = value;
    }
    private botName(): string {
        return this._settings.botName || 'Bot';
    }
    private userName(): string {
        return this._settings.userName || 'User';
    }
    private contextBuilder() {
        return this._contextBuilder;
    }

    protected startingRequest(message: Message): Message {
        message = super.startingRequest(message);
        if (!message.source.name) {
            message.source.name = this.userName();
        }
        return message;
    }
    protected async collectContext(
        message: Message
    ): Promise<string | undefined> {
        let context = await super.collectContext(message);
        if (!context) {
            context = this.collectRecentHistoryWindow(
                this.contextBuilder(),
                message
            );
        }
        return context;
    }
    protected buildPrompt(
        message: Message,
        context?: string
    ): string | undefined {
        let prompt = super.buildPrompt(message, context);
        if (!prompt) {
            prompt = StringBuilder.join(
                this.settings.promptStartBlock,
                context,
                this.settings.promptEndBlock
            );
        }
        return prompt;
    }
    protected onResponse(message: Message, response: Message): Message {
        super.onResponse(message, response);
        if (!response.source.name) {
            response.source.name = this.botName();
        }
        return response;
    }
    protected async appendToHistory(message: Message): Promise<void> {
        if (this.settings.embeddingGenerator && !message.embedding) {
            message.embedding =
                await this._settings.embeddingGenerator?.createEmbedding(
                    message.text
                );
        }
        this.history.append(message);
    }
    public collectRecentHistoryWindow(
        builder: ContextBuilder,
        message?: Message
    ): string {
        builder.start();
        if (message) {
            if (message.source.name) {
                builder.append(message.source.name);
            }
            builder.append(message.text);
        }
        builder.appendEvents(this._history.allEvents(true));
        return builder.complete();
    }
}
