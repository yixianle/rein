const is = require('is-type-of');
const Worker = require('./lib/worker');
const { EventEmitter } = require('async-events-listener');

module.exports = class WorkerRuntime extends Worker {
  constructor(app) {
    super();
    this.$callbackId = 1;
    this.$callbacks = {};
    this.$plugins = {};
    this.$app = app;
    this.$server = null;
    this.$inCluster = true;
    this.$events = new EventEmitter();
    this.context.send = this.send.bind(this);
    this.context.sendback = this.sendback.bind(this);
    this.context.error = this._app.error;
  }
  
  /**
   * receive a message
   * @param args
   * @returns {module.WorkerRuntime}
   */
  receive(...args) {
    this.$events.on(...args);
    return this;
  }
  
  /**
   * send a non-back message
   * @param args
   * @returns {module.WorkerRuntime}
   */
  send(...args) {
    this.$app.send(...args);
    return this;
  }
  
  /**
   * send a fallback message
   * @param to
   * @param event
   * @param data
   * @param timeout default: 3000
   * @returns {Promise<any>}
   */
  sendback(to, event, data, timeout) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const time = Date.now();
      const id = this.$callbackId++;
      const receiver = (err, fallback) => {
        clearInterval(timer);
        delete this.$callbacks[id];
        if (err) return reject(new Error(err));
        resolve(fallback);
      };
      this.$callbacks[id] = receiver;
  
      /**
       * send data structure
       * action: <event>
       * body:
       *  __ipc_callback__: <id>
       *  data: <data>
       */
      this.send(to, event, {
        __ipc_callback__: id,
        data
      });
      timeout = timeout || this.config.agent_timeout || 3000;
      timer = setInterval(() => {
        if (Date.now() - time > timeout) {
          clearInterval(timer);
          delete this.$callbacks[id];
          reject(new Error(`timeout ${timeout}s: ${to}:${event}`));
        }
      }, 10);
    });
  }
  
  _fetchAgentPlugins(name, plugins = []) {
    plugins.forEach(plugin => {
      if (!this.$plugins[plugin]) this.$plugins[plugin] = [];
      const index = this.$plugins[plugin].indexOf(name);
      if (index === -1) {
        this.$plugins[plugin].push(name);
      }
    });
  }
  
  /**
   * receive message from upstream
   * @param msg
   * @returns {Promise<void>}
   */
  async message(msg) {
    if (msg.action = 'agent:plugins') return await this._fetchAgentPlugins(msg.body.name, msg.body.plugins);
    if (msg.action === 'cluster:ready') return await this._app.invoke('ready');
    if (!isNaN(msg.action)) {
      if (this.$callbacks[msg.action]) await this.$callbacks[msg.action](msg.body.error, msg.body.data);
      return;
    }
    await this.$events.emit(msg.action, msg.body);
  }
  
  /**
   * how to create service?
   * @returns {Promise<void>}
   */
  async create() {
    this.config.cwd = this.$app._argv.cwd;
    this.config.service = this.$app._argv.service;
    await this.initialize();
    this.$server = await this.listen();
  }
  
  /**
   * how to destroy service?
   * @param signal
   * @returns {Promise<void>}
   */
  async destroy(signal) {
    await this._app.invoke('beforeDestroy', signal);
    this.$server.close();
    await this._app.invoke('destroyed', signal);
  }
};