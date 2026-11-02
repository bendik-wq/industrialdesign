import{A as Dt,B as Ft,C as Nt,D,E as Pt,F as Ht,G as rt,H as ot,J as q,L as E,M as G,N as I,O as F,P as J,R as N,S as _t,U as ct,V as Vt,a as u,b as g,c as v,d as Et,e as zt,f as A,g as S,h as nt,i as Ct,j as K,k as L,l as U,m as Ot,n as st,o as It,p as b,q as B,r as h,s as Lt,t as W,u as jt,v as T,x as at,y as Bt,z as Wt}from"./chunk-S7GBA5XF.js";import{c as lt,d as ht,h as dt}from"./chunk-STCWTT52.js";import{a as we}from"./chunk-WOT6VMZA.js";var ge={};we(ge,{Audio:()=>Mi,Broadcast:()=>gt,CATALOG_FORMATS:()=>ae,Hang:()=>Vt,Net:()=>jt,Player:()=>pe,Signals:()=>Et,Sync:()=>bt,Text:()=>Si,Video:()=>Ti});var ve=U([st(["loc","cmaf","legacy","mediatimeline","eventtimeline"]),A()]),Ae=U([st(["video","audio","audiodescription","caption","subtitle","signlanguage"]),A()]),$t={name:A(),packaging:ve,isLive:b(nt()),role:b(Ae),codec:b(A()),width:b(S()),height:b(S()),framerate:b(S()),samplerate:b(S()),channelConfig:b(A()),bitrate:b(S()),stalled:b(nt()),initData:b(A()),renderGroup:b(S()),altGroup:b(S()),maxGrpSapStartingType:b(S()),maxObjSapStartingType:b(S()),jitter:b(S()),delay:b(S())},ke=L($t),Ci=L({tracks:K(ke),ext:b(Ot(A(),Ct()))}),xe=["version","generatedAt","isComplete","tracks","initDataList"];var Me=L({id:A(),type:A(),data:A()}),Se=L({...$t,initRef:b(A())}),Te=L({version:U([It(1),A()]),tracks:b(K(Se)),initDataList:b(K(Me))});function Re(t){let e=new TextDecoder().decode(t);try{let i=JSON.parse(e),n=Te.parse(i),s=Object.create(null);for(let[o,c]of Object.entries(i))xe.includes(o)||(s[o]=c);let a=new Map((n.initDataList??[]).filter(o=>o.type==="inline").map(o=>[o.id,o.data])),r=(n.tracks??[]).map(({initRef:o,...c})=>(c.isLive??=!1,c.initData===void 0&&o!==void 0&&(c.initData=a.get(o)),c));return Object.keys(s).length>0?{tracks:r,ext:s}:{tracks:r}}catch(i){throw console.warn("invalid MSF catalog",e),i}}async function Yt(t){let e=await t.readFrame();if(e)return Re(e.payload)}function $(t){let e=atob(t),i=new Uint8Array(e.length);for(let n=0;n<e.length;n++)i[n]=e.charCodeAt(n);return i}function ft(t,e){if(t.get(e.broadcast.closed)!==void 0)return;let i=e.broadcast.track(e.track).subscribe({priority:e.priority,maxAge:e.maxAge.peek()});return t.cleanup(()=>i.close()),t.run(n=>{i.update({priority:e.priority,maxAge:n.get(e.maxAge)})}),i}async function Q(t){try{return await t.next()}catch(e){if(!(e instanceof W.Stream))throw e;console.debug("media subscription ended",e);return}}var k=0,P=1,O=2,H=3,Ee=4,ze=4294967295n;function C(t,e){return BigInt(t>>>0)<<32n|BigInt(e>>>0)}function z(t){return Number(t>>32n)|0}function Ce(t){return!!(z(t)&1)}function x(t){return Number(t&ze)|0}function Oe(t){return t<=1?1:1<<32-Math.clz32(t-1)}function Zt(t,e,i,n=!1){if(t<=0)throw Error("invalid channels");if(e<=0||e>2**30)throw Error("invalid capacity");if(i<=0)throw Error("invalid sample rate");e=Oe(e);let s=new SharedArrayBuffer(t*e*Float32Array.BYTES_PER_ELEMENT),a=new SharedArrayBuffer(Ee*Int32Array.BYTES_PER_ELEMENT),r=new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT),o=new Int32Array(a);return Atomics.store(o,O,1),{channels:t,capacity:e,rate:i,samples:s,control:a,state:r,buffered:n}}function Kt(t,e){return(t-e|0)>0?t:e}function _(t,e){return t&e-1}var Ie=class te{channels;capacity;rate;buffered;init;#t;#e;#i;#n=!1;#s=0;#a=0;#r=0;constructor(e,i){this.channels=e.channels,this.capacity=e.capacity,this.rate=e.rate,this.buffered=e.buffered,this.init=e,this.#t=new Int32Array(e.control),this.#e=new BigInt64Array(e.state),this.#i=[];for(let n=0;n<this.channels;n++)this.#i.push(new Float32Array(e.samples,n*this.capacity*Float32Array.BYTES_PER_ELEMENT,this.capacity));i!==void 0&&this.#o(i)}#o(e){if(e.channels!==this.channels||e.rate!==this.rate)return;let i=Atomics.load(e.#t,H),n=Atomics.load(e.#e,0);for(;;){let s=Atomics.load(this.#e,0);if(Atomics.load(this.#t,H)!==i||(x(n)-x(s)|0)<=0)return;let a=C(z(s),x(n));if(Atomics.compareExchange(this.#e,0,s,a)===s)return}}#c(e){for(;;){let i=Atomics.load(this.#e,0);if((e-x(i)|0)<=0)return;let n=C(z(i),e);if(Atomics.compareExchange(this.#e,0,i,n)===i)return}}#l(e){for(;;){let i=Atomics.load(this.#e,0),n=C(z(i)+e|0,x(i));if(Atomics.compareExchange(this.#e,0,i,n)===i)return}}insert(e,i){if(i.length!==this.channels)throw Error("wrong number of channels");let n=Math.round(h.Second.fromMicro(e)*this.rate),s=i[0].length,a=0;if(!this.#n){this.#s=n;let f=z(Atomics.load(this.#e,0));Atomics.add(this.#t,H,1),Atomics.store(this.#e,0,C(f+2|0,0)),Atomics.store(this.#t,k,0),this.#n=!0,this.#a=0,this.#r=0}n=n-this.#s|0;let r=n+s|0,o=x(Atomics.load(this.#e,0)),c=o-n|0;if(c>0){if(c>=s)return;a=c,n=n+c|0}let l=s-a;(r-o|0)>this.capacity&&this.#c(r-this.capacity|0);let d=Atomics.load(this.#t,k),p=n-d|0;if(p>0){let f=Math.min(p,this.capacity);for(let m=0;m<this.channels;m++){let y=this.#i[m];for(let w=0;w<f;w++)y[_(d+w|0,this.capacity)]=0}}for(let f=0;f<this.channels;f++){let m=i[f],y=this.#i[f];for(let w=0;w<l;w++)y[_(n+w|0,this.capacity)]=m[a+w]}Atomics.store(this.#t,k,Kt(Atomics.load(this.#t,k),r)),this.#h()}#h(){let e=x(Atomics.load(this.#e,0)),i=Atomics.load(this.#t,k),n=Atomics.load(this.#t,P);(i-e|0)>=n&&n>0&&Atomics.store(this.#t,O,0)}read(e){let i=Atomics.load(this.#e,0);if(Atomics.load(this.#t,O)===1||Ce(i))return 0;let n=x(i),s=Atomics.load(this.#t,k),a=Atomics.load(this.#t,P),r=s-n|0;if(!this.buffered&&a>0&&r>a){let d=s-a|0;(d-n|0)>0&&(n=d)}let o=s-n|0,c=Math.min(o,e[0].length);if(c<=0)return(n-x(i)|0)>0&&Atomics.compareExchange(this.#e,0,i,C(z(i),n)),0;for(let d=0;d<this.channels;d++){let p=this.#i[d],f=e[d];for(let m=0;m<c;m++)f[m]=p[_(n+m|0,this.capacity)]}let l=C(z(i),n+c|0);if(Atomics.compareExchange(this.#e,0,i,l)!==i){for(let d=0;d<this.channels;d++)e[d].fill(0,0,c);return 0}return c}setLatency(e){let i=Atomics.exchange(this.#t,P,e);i>0&&e>i&&(Atomics.store(this.#t,O,1),this.#l(2)),this.#h()}truncate(e){let i=Math.round(h.Second.fromMicro(e)*this.rate)-this.#s|0;if(!((Atomics.load(this.#t,k)-i|0)<=0)){for(this.#l(1);;){let n=Atomics.load(this.#t,k),s=Kt(i,x(Atomics.load(this.#e,0)));if((n-s|0)<=0||Atomics.compareExchange(this.#t,k,n,s)===n)break}this.#l(1)}}reset(){this.#n=!1,Atomics.store(this.#t,O,1);let e=Atomics.load(this.#t,k),i=Atomics.load(this.#e,0);Atomics.store(this.#e,0,C(z(i),e))}resize(e){let i=Zt(this.channels,e,this.rate,this.buffered),n=new te(i);n.#n=this.#n,n.#s=this.#s;let s=Atomics.load(this.#e,0),a=x(s),r=Atomics.load(this.#t,k),o=Atomics.load(this.#t,P),c=Atomics.load(this.#t,O),l=r-a|0,d=Math.max(0,Math.min(l,n.capacity)),p=r-d|0;for(let f=0;f<this.channels;f++){let m=this.#i[f],y=n.#i[f];for(let w=0;w<d;w++){let M=p+w|0;y[_(M,n.capacity)]=m[_(M,this.capacity)]}}return Atomics.store(n.#t,H,Atomics.load(this.#t,H)),Atomics.store(n.#e,0,C(z(s),p)),Atomics.store(n.#t,k,r),Atomics.store(n.#t,P,o),Atomics.store(n.#t,O,c),n.#a=this.#d(a)+(p-a|0),n.#r=p,n}#d(e){return this.#a+=e-this.#r|0,this.#r=e,this.#a}#f(){return this.#d(x(Atomics.load(this.#e,0)))}get timestamp(){return h.Micro.fromSecond((this.#s+this.#f())/this.rate)}get anchored(){return this.#n}get stalled(){return Atomics.load(this.#t,O)===1}get length(){return Atomics.load(this.#t,k)-x(Atomics.load(this.#e,0))|0}},ee=class{#t;#e;#i=[];#n;#s=!0;#a;#r;constructor(t,e){this.#t=t,this.#e=e}setHeadroom(t){this.#e=t}wait(t,e){return!this.#t||e.aborted||this.#c(t)?Promise.resolve():new Promise(i=>{let n=()=>{this.#i=this.#i.filter(a=>a!==s),i()},s={timestamp:t,resolve:()=>{e.removeEventListener("abort",n),i()}};e.addEventListener("abort",n,{once:!0}),this.#i.push(s)})}observe(t,e){this.#n=t,this.#s=e,e||(this.#a=void 0,this.#r=void 0),this.#o()}reset(){this.#n=void 0,this.#s=!0,this.#a=void 0,this.#r=void 0,this.#o()}close(){this.#t=!1;for(let{resolve:t}of this.#i)t();this.#i=[]}#o(){this.#i=this.#i.filter(({timestamp:t,resolve:e})=>!this.#c(t)||(e(),!1))}#c(t){let e=this.#n;if(!this.#s&&e!==void 0)return t-this.#e<=e;let i=this.#a,n=this.#r;if(i!==void 0&&n!==void 0){let s=e??i;if(t-this.#e>s&&n-this.#e>=s)return!1}return this.#a??=t,this.#r=n===void 0?t:Math.max(n,t),!0}};function X(t,e){return h.Micro.fromSecond(t/e)}function Le(){return!(typeof SharedArrayBuffer>"u"||typeof crossOriginIsolated<"u"&&!crossOriginIsolated)}function je(t,e,i,n,s=!1){return Le()?(console.log("[audio] using SharedArrayBuffer audio buffer"),new Be(t,e,i,n,s)):(console.warn("[audio] SharedArrayBuffer unavailable, falling back to the higher latency postMessage audio buffer. Serve the page cross-origin isolated (Cross-Origin-Opener-Policy: same-origin, Cross-Origin-Embedder-Policy: require-corp) to avoid this."),new We(t,e,i,n,s))}var Be=class{rate;channels;#t;#e;#i=new u(0);timestamp=this.#i;#n=new u(!0);stalled=this.#n;#s;#a=new v;constructor(t,e,i,n,s){this.#t=t,this.channels=e,this.rate=i;let a=Math.max(i,n*2);this.#s=new ee(s,X(n,i));let r=Zt(e,a,i,s);this.#e=new Ie(r),this.#e.setLatency(n);let o={type:"init-shared",...r};t.port.postMessage(o),this.#a.interval(()=>{this.#i.set(this.#e.timestamp),this.#n.set(this.#e.stalled),this.#r()},50)}#r(){this.#s.observe(this.#e.anchored?this.#e.timestamp:void 0,this.#e.stalled)}insert(t,e){this.#e.insert(t,e)}setLatency(t){if(this.#s.setHeadroom(X(t,this.rate)),this.#e.setLatency(t),this.#e.capacity<t*1.5){let e=Math.max(this.rate,t*2);this.#e=this.#e.resize(e);let i={type:"init-shared",...this.#e.init};this.#t.port.postMessage(i)}}truncate(t){this.#e.truncate(t)}reset(){this.#e.reset(),this.#s.reset()}wait(t,e){return this.#r(),this.#s.wait(t,e)}close(){this.#s.close(),this.#a.close()}},We=class{rate;channels;#t;#e=new u(0);timestamp=this.#e;#i=new u(!0);stalled=this.#i;#n;#s=0;#a=new v;constructor(t,e,i,n,s){this.#t=t,this.channels=e,this.rate=i,this.#n=new ee(s,X(n,i));let a={type:"init-post",channels:e,rate:i,latency:h.Milli.fromSecond(n/i),buffered:s};t.port.postMessage(a),this.#a.event(t.port,"message",r=>{let o=r.data;o?.type==="state"&&(this.#e.set(o.timestamp),this.#i.set(o.stalled),o.epoch===this.#s&&this.#n.observe(o.anchored?o.timestamp:void 0,o.stalled))}),t.port.start()}insert(t,e){let i={type:"data",data:e,timestamp:t};this.#t.port.postMessage(i,e.map(n=>n.buffer))}setLatency(t){this.#n.setHeadroom(X(t,this.rate));let e={type:"latency",latency:h.Milli.fromSecond(t/this.rate)};this.#t.port.postMessage(e)}truncate(t){let e={type:"truncate",timestamp:t};this.#t.port.postMessage(e)}reset(){this.#s++;let t={type:"reset",epoch:this.#s};this.#t.port.postMessage(t),this.#n.reset()}wait(t,e){return this.#n.wait(t,e)}close(){this.#n.close(),this.#a.close()}},De=128,Fe=20,Ne=1024,Pe=1152,He=576,_e=32e3;function ie(t){return{codec:t.codec,container:t.container,description:t.description,sampleRate:t.sampleRate,numberOfChannels:t.numberOfChannels}}function Ve(t){return{broadcast:t.broadcast,decoder:ie(t)}}function $e(t){let e=(t.jitter||Ye(t))??0,i=Math.ceil(De/t.sampleRate*1e3);return h.Milli((t.delay??0)+e+i)}function Ye(t){if(t.codec.startsWith("opus"))return Fe;if(t.codec.startsWith("mp4a"))return Math.ceil(Ne/t.sampleRate*1e3);if(t.codec==="mp3"){let e=t.sampleRate>=_e?Pe:He;return Math.ceil(e/t.sampleRate*1e3)}}var Ke=class{#t=!1;#e=!1;opened(){this.#t&&(this.#e=!0),this.#t=!0}takeover(){let t=this.#e;return this.#e=!1,t}},Ue=128;function Ut(t,e){return Math.max(Ue,Math.ceil(t*h.Second.fromMilli(e)))}var qt=class{#t;#e=[];#i;#n;#s;constructor(t){this.#t=t}push(t){let e=this.#t?.();if(!e)return[t];let{group:i,frame:n}=t;if(this.#i??={group:i,timestamp:n.timestamp},i>this.#i.group)return[...this.flush(),t];this.#e.push(t);let s=Math.min(this.#n?.oldest??n.timestamp,n.timestamp),a=Math.max(this.#n?.newest??n.timestamp,n.timestamp);return this.#n={oldest:s,newest:a},i===this.#i.group&&n.timestamp-this.#i.timestamp>e.floor||a-s>=e.maxDelay?this.flush():[]}flush(){this.#t=void 0;let t=this.#e;return this.#e=[],t.sort((e,i)=>e.frame.timestamp-i.frame.timestamp)}admit(t){let{timestamp:e}=t.frame;return this.#s!==void 0&&e<this.#s?!1:(this.#s=e,!0)}reset(){this.#s=void 0}},qe=new Blob([`Object.assign((value) => value, {
	zero: 0,
	fromMicro: (us) => us * 1e3,
	fromMilli: (ms) => ms * 1e6,
	fromSecond: (s) => s * 1e9,
	toMicro: (ns) => ns / 1e3,
	toMilli: (ns) => ns / 1e6,
	toSecond: (ns) => ns / 1e9,
	now: () => performance.now() * 1e6,
	add: (a, b) => a + b,
	sub: (a, b) => a - b,
	mul: (a, b) => a * b,
	div: (a, b) => a / b,
	max: (a, b) => Math.max(a, b),
	min: (a, b) => Math.min(a, b)
});
/** Constructors, conversions, and arithmetic for {@link Micro} values. */
const Micro = Object.assign((value) => value, {
	zero: 0,
	fromNano: (ns) => ns / 1e3,
	fromMilli: (ms) => ms * 1e3,
	fromSecond: (s) => s * 1e6,
	toNano: (us) => us * 1e3,
	toMilli: (us) => us / 1e3,
	toSecond: (us) => us / 1e6,
	now: () => performance.now() * 1e3,
	add: (a, b) => a + b,
	sub: (a, b) => a - b,
	mul: (a, b) => a * b,
	div: (a, b) => a / b,
	max: (a, b) => Math.max(a, b),
	min: (a, b) => Math.min(a, b)
});
Object.assign((value) => value, {
	zero: 0,
	fromNano: (ns) => ns / 1e6,
	fromMicro: (us) => us / 1e3,
	fromSecond: (s) => s * 1e3,
	toNano: (ms) => ms * 1e6,
	toMicro: (ms) => ms * 1e3,
	toSecond: (ms) => ms / 1e3,
	now: () => performance.now(),
	add: (a, b) => a + b,
	sub: (a, b) => a - b,
	mul: (a, b) => a * b,
	div: (a, b) => a / b,
	max: (a, b) => Math.max(a, b),
	min: (a, b) => Math.min(a, b)
});
Object.assign((unitsPerSecond) => {
	if (!Number.isSafeInteger(unitsPerSecond) || unitsPerSecond <= 0) throw new RangeError(\`invalid timescale: \${unitsPerSecond}\`);
	return unitsPerSecond;
}, {
	/** One unit per second. */
	SECOND: 1,
	/** 1,000 units per second. */
	MILLI: 1e3,
	/** 1,000,000 units per second. */
	MICRO: 1e6,
	/** 1,000,000,000 units per second. */
	NANO: 1e9
});
/** Constructors, conversions, and arithmetic for {@link Second} values. */
const Second = Object.assign((value) => value, {
	zero: 0,
	fromNano: (ns) => ns / 1e9,
	fromMicro: (us) => us / 1e6,
	fromMilli: (ms) => ms / 1e3,
	toNano: (s) => s * 1e9,
	toMicro: (s) => s * 1e6,
	toMilli: (s) => s * 1e3,
	now: () => performance.now() / 1e3,
	add: (a, b) => a + b,
	sub: (a, b) => a - b,
	mul: (a, b) => a * b,
	div: (a, b) => a / b,
	max: (a, b) => Math.max(a, b),
	min: (a, b) => Math.min(a, b)
});
//#endregion
//#region src/audio/ring-buffer.ts
var AudioRingBuffer = class {
	#buffer;
	#writeIndex = 0;
	#readIndex = 0;
	rate;
	channels;
	#stalled = true;
	#buffered;
	#latencySamples;
	#anchored = false;
	constructor(props) {
		if (props.channels <= 0) throw new Error("invalid channels");
		if (props.rate <= 0) throw new Error("invalid sample rate");
		if (props.latency <= 0) throw new Error("invalid latency");
		this.#latencySamples = Math.ceil(props.rate * Second.fromMilli(props.latency));
		if (this.#latencySamples === 0) throw new Error("empty buffer");
		this.rate = props.rate;
		this.channels = props.channels;
		this.#buffered = props.buffered ?? false;
		const capacity = this.#capacityFor(this.#latencySamples);
		this.#buffer = [];
		for (let i = 0; i < this.channels; i++) this.#buffer[i] = new Float32Array(capacity);
	}
	#capacityFor(latencySamples) {
		return this.#buffered ? latencySamples * 2 : latencySamples;
	}
	get stalled() {
		return this.#stalled;
	}
	get timestamp() {
		return Micro.fromSecond(this.#readIndex / this.rate);
	}
	/** Whether an insert has anchored the indices since creation or the last reset. */
	get anchored() {
		return this.#anchored;
	}
	get length() {
		return this.#writeIndex - this.#readIndex;
	}
	get capacity() {
		return this.#buffer[0]?.length;
	}
	resize(latency) {
		const latencySamples = Math.ceil(this.rate * Second.fromMilli(latency));
		if (latencySamples > this.#latencySamples) this.#stalled = true;
		this.#latencySamples = latencySamples;
		const newCapacity = this.#capacityFor(this.#latencySamples);
		if (newCapacity !== this.capacity) this.#reallocate(newCapacity);
		if (latencySamples > 0 && this.length >= latencySamples) this.#stalled = false;
	}
	#reallocate(newCapacity) {
		if (newCapacity === 0) throw new Error("empty buffer");
		const newBuffer = [];
		for (let i = 0; i < this.channels; i++) newBuffer[i] = new Float32Array(newCapacity);
		const samplesToKeep = Math.min(this.length, newCapacity);
		if (samplesToKeep > 0) {
			const copyStart = this.#writeIndex - samplesToKeep;
			for (let channel = 0; channel < this.channels; channel++) {
				const src = this.#buffer[channel];
				const dst = newBuffer[channel];
				for (let i = 0; i < samplesToKeep; i++) {
					const srcPos = (copyStart + i) % src.length;
					const dstPos = (copyStart + i) % dst.length;
					dst[dstPos] = src[srcPos];
				}
			}
		}
		this.#buffer = newBuffer;
		this.#readIndex = this.#writeIndex - samplesToKeep;
		if (samplesToKeep === 0) this.#stalled = true;
	}
	write(timestamp, data) {
		if (data.length !== this.channels) throw new Error("wrong number of channels");
		let start = Math.round(Second.fromMicro(timestamp) * this.rate);
		let samples = data[0].length;
		if (!this.#anchored) {
			this.#readIndex = start;
			this.#writeIndex = start;
			this.#anchored = true;
		}
		let offset = this.#readIndex - start;
		if (offset > samples) return;
		else if (offset > 0) {
			samples -= offset;
			start += offset;
		} else offset = 0;
		const end = start + samples;
		const overflow = end - this.#readIndex - this.#buffer[0].length;
		if (overflow >= 0) {
			this.#stalled = false;
			this.#readIndex += overflow;
		}
		if (start > this.#writeIndex) {
			const gapSize = Math.min(start - this.#writeIndex, this.#buffer[0].length);
			if (gapSize === 1) console.warn("floating point inaccuracy detected");
			for (let channel = 0; channel < this.channels; channel++) {
				const dst = this.#buffer[channel];
				for (let i = 0; i < gapSize; i++) {
					const writePos = (this.#writeIndex + i) % dst.length;
					dst[writePos] = 0;
				}
			}
		}
		for (let channel = 0; channel < this.channels; channel++) {
			let src = data[channel];
			src = src.subarray(src.length - samples);
			const dst = this.#buffer[channel];
			if (src.length !== samples) throw new Error("mismatching number of samples");
			for (let i = 0; i < samples; i++) {
				const writePos = (start + i) % dst.length;
				dst[writePos] = src[i];
			}
		}
		if (end > this.#writeIndex) this.#writeIndex = end;
		if (this.#buffered && this.length >= this.#latencySamples) this.#stalled = false;
	}
	/**
	* Drop buffered samples at or after \`timestamp\`, keeping whatever is already due.
	*
	* A successor track overwrites the slots its own samples land on, but anything the previous
	* track wrote beyond them would otherwise still play once the successor runs out.
	*/
	truncate(timestamp) {
		const target = Math.round(Second.fromMicro(timestamp) * this.rate);
		if (target >= this.#writeIndex) return;
		this.#writeIndex = Math.max(target, this.#readIndex);
	}
	reset() {
		this.#readIndex = 0;
		this.#writeIndex = 0;
		this.#stalled = true;
		this.#anchored = false;
	}
	read(output) {
		if (output.length !== this.channels) throw new Error("wrong number of channels");
		if (this.#stalled) return 0;
		const samples = Math.min(this.#writeIndex - this.#readIndex, output[0].length);
		if (samples === 0) return 0;
		for (let channel = 0; channel < this.channels; channel++) {
			const dst = output[channel];
			const src = this.#buffer[channel];
			if (dst.length !== output[0].length) throw new Error("mismatching number of samples");
			for (let i = 0; i < samples; i++) {
				const readPos = (this.#readIndex + i) % src.length;
				dst[i] = src[readPos];
			}
		}
		this.#readIndex += samples;
		return samples;
	}
};
//#endregion
//#region src/audio/shared-ring-buffer.ts
const WRITE = 0;
const LATENCY = 1;
const STALLED = 2;
const TIMELINE = 3;
const CONTROL_SLOTS = 4;
/**
* The playhead and its mutation epoch, packed into one 64-bit word: epoch in the high
* half, read cursor in the low half.
*
* They have to move together. The reader samples the ring, copies, and only then publishes, and
* the writer can rebase the timeline anywhere in between. Checking an epoch and then writing a
* cursor leaves a window between the two no ordering closes, which is how a stale cursor ends up
* on a fresh timeline: the playhead lands past WRITE, \`read\` returns nothing, and \`insert\` drops
* everything as too old until WRITE catches up. Packed, the check *is* the write: the reader
* compare-exchanges the whole word, so a rebase makes its publish fail rather than land.
*/
const CURSOR_MASK = 4294967295n;
function pack(epoch, read) {
	return BigInt(epoch >>> 0) << 32n | BigInt(read >>> 0);
}
/**
* The mutation epoch. Even while settled, odd while \`truncate\` retreats WRITE.
*
* WRITE lives in a different word, so a retreat cannot move it and the epoch together. Marking
* the epoch on either side of the retreat is what covers the gap: a reader that snapshotted
* before the mark finds the word moved and its exchange fails, one that snapshots between the
* marks sees the odd epoch and renders silence, and one that snapshots after already reads the
* retreated WRITE. So the writer steps by two on a re-anchor, keeping odd for the retreat alone.
*/
function epochOf(state) {
	return Number(state >> 32n) | 0;
}
/** Whether a \`truncate\` is mid-retreat, so WRITE may still describe samples it is dropping. */
function retreating(state) {
	return (epochOf(state) & 1) !== 0;
}
/** The playhead half, back as an i32 so the modular comparisons elsewhere still hold. */
function readOf(state) {
	return Number(state & CURSOR_MASK) | 0;
}
/** Rounds up to a power of two, which is what makes \`slot\` wrap-invariant. */
function ceilPow2(n) {
	return n <= 1 ? 1 : 1 << 32 - Math.clz32(n - 1);
}
/**
* Allocate the shared memory for a ring holding at least \`capacity\` samples per channel.
*
* The capacity is rounded up to a power of two so \`slot\` can mask instead of taking a
* remainder; read \`init.capacity\` back rather than assuming the requested value.
*/
function allocSharedRingBuffer(channels, capacity, rate, buffered = false) {
	if (channels <= 0) throw new Error("invalid channels");
	if (capacity <= 0 || capacity > 2 ** 30) throw new Error("invalid capacity");
	if (rate <= 0) throw new Error("invalid sample rate");
	capacity = ceilPow2(capacity);
	const samples = new SharedArrayBuffer(channels * capacity * Float32Array.BYTES_PER_ELEMENT);
	const control = new SharedArrayBuffer(CONTROL_SLOTS * Int32Array.BYTES_PER_ELEMENT);
	const state = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
	const ctrl = new Int32Array(control);
	Atomics.store(ctrl, STALLED, 1);
	return {
		channels,
		capacity,
		rate,
		samples,
		control,
		state,
		buffered
	};
}
/** Modular i32 max: returns a if a is ahead of b, else b. */
function i32Max(a, b) {
	return (a - b | 0) > 0 ? a : b;
}
/**
* Maps a sample index to a [0, capacity) array slot.
*
* \`capacity\` is a power of two, so masking is exact for negative indexes and, unlike a
* remainder, survives the i32 wrap: consecutive indexes stay consecutive slots across
* 0x7fffffff -> 0x80000000, which is what keeps unread samples from aliasing there.
*/
function slot(idx, capacity) {
	return idx & capacity - 1;
}
var SharedRingBuffer = class SharedRingBuffer {
	channels;
	capacity;
	rate;
	buffered;
	init;
	#control;
	#state;
	#samples;
	#anchored = false;
	#anchor = 0;
	#position = 0;
	#lastRead = 0;
	/**
	* Wrap the shared memory described by \`init\`.
	*
	* Pass \`previous\` in the worklet when this ring replaces one already being read. \`resize\`
	* snapshots the playhead on the main thread and hands the replacement over by message, so the
	* reader keeps draining the old ring in the meantime. Carrying its cursor across means those
	* samples are not played twice.
	*/
	constructor(init, previous) {
		this.channels = init.channels;
		this.capacity = init.capacity;
		this.rate = init.rate;
		this.buffered = init.buffered;
		this.init = init;
		this.#control = new Int32Array(init.control);
		this.#state = new BigInt64Array(init.state);
		this.#samples = [];
		for (let i = 0; i < this.channels; i++) this.#samples.push(new Float32Array(init.samples, i * this.capacity * Float32Array.BYTES_PER_ELEMENT, this.capacity));
		if (previous !== void 0) this.#handoff(previous);
	}
	/**
	* Carry \`source\`'s playhead across, if the replacement is still the timeline it belongs to.
	*
	* Truncation changes the mutation epoch but preserves timeline identity. Sample state before
	* identity: a re-anchor publishes identity first, then replaces state. Either the identity
	* check rejects the old cursor, the exchange fails, or the re-anchor overwrites the carried
	* cursor. A truncate only forces a retry, preserving audio consumed since the resize.
	*/
	#handoff(source) {
		if (source.channels !== this.channels || source.rate !== this.rate) return;
		const timeline = Atomics.load(source.#control, TIMELINE);
		const from = Atomics.load(source.#state, 0);
		for (;;) {
			const state = Atomics.load(this.#state, 0);
			if (Atomics.load(this.#control, TIMELINE) !== timeline) return;
			if ((readOf(from) - readOf(state) | 0) <= 0) return;
			const next = pack(epochOf(state), readOf(from));
			if (Atomics.compareExchange(this.#state, 0, state, next) === state) return;
		}
	}
	/**
	* Move the playhead forward to \`candidate\`, staying on whatever timeline is current.
	*
	* Retries while the word changes under it, and never steps backwards. Used by the writer's
	* overflow path; the reader publishes with its own exchange so it can tell a rebase apart
	* from losing a race.
	*/
	#advance(candidate) {
		for (;;) {
			const state = Atomics.load(this.#state, 0);
			if ((candidate - readOf(state) | 0) <= 0) return;
			const next = pack(epochOf(state), candidate);
			if (Atomics.compareExchange(this.#state, 0, state, next) === state) return;
		}
	}
	/**
	* Step the epoch by \`by\`, leaving the playhead wherever the reader has taken it.
	*
	* Retries while the word changes under it: only the epoch half is the writer's to move.
	*/
	#step(by) {
		for (;;) {
			const state = Atomics.load(this.#state, 0);
			const next = pack(epochOf(state) + by | 0, readOf(state));
			if (Atomics.compareExchange(this.#state, 0, state, next) === state) return;
		}
	}
	/**
	* Insert audio samples at the given timestamp.
	* Main thread only. Handles out-of-order writes, gap filling, and overflow.
	*/
	insert(timestamp, data) {
		if (data.length !== this.channels) throw new Error("wrong number of channels");
		let start = Math.round(Second.fromMicro(timestamp) * this.rate);
		const originalLength = data[0].length;
		let offset = 0;
		if (!this.#anchored) {
			this.#anchor = start;
			const epoch = epochOf(Atomics.load(this.#state, 0));
			Atomics.add(this.#control, TIMELINE, 1);
			Atomics.store(this.#state, 0, pack(epoch + 2 | 0, 0));
			Atomics.store(this.#control, WRITE, 0);
			this.#anchored = true;
			this.#position = 0;
			this.#lastRead = 0;
		}
		start = start - this.#anchor | 0;
		const end = start + originalLength | 0;
		const read = readOf(Atomics.load(this.#state, 0));
		const behind = read - start | 0;
		if (behind > 0) {
			if (behind >= originalLength) return;
			offset = behind;
			start = start + behind | 0;
		}
		const samples = originalLength - offset;
		if ((end - read | 0) > this.capacity) this.#advance(end - this.capacity | 0);
		const write = Atomics.load(this.#control, WRITE);
		const gap = start - write | 0;
		if (gap > 0) {
			const gapSize = Math.min(gap, this.capacity);
			for (let channel = 0; channel < this.channels; channel++) {
				const dst = this.#samples[channel];
				for (let i = 0; i < gapSize; i++) dst[slot(write + i | 0, this.capacity)] = 0;
			}
		}
		for (let channel = 0; channel < this.channels; channel++) {
			const src = data[channel];
			const dst = this.#samples[channel];
			for (let i = 0; i < samples; i++) dst[slot(start + i | 0, this.capacity)] = src[offset + i];
		}
		Atomics.store(this.#control, WRITE, i32Max(Atomics.load(this.#control, WRITE), end));
		this.#resume();
	}
	#resume() {
		const read = readOf(Atomics.load(this.#state, 0));
		const write = Atomics.load(this.#control, WRITE);
		const latency = Atomics.load(this.#control, LATENCY);
		if ((write - read | 0) >= latency && latency > 0) Atomics.store(this.#control, STALLED, 0);
	}
	/**
	* Read audio samples into the output buffers.
	* AudioWorklet only. Returns the number of samples read.
	*/
	read(output) {
		const state = Atomics.load(this.#state, 0);
		if (Atomics.load(this.#control, STALLED) === 1) return 0;
		if (retreating(state)) return 0;
		let read = readOf(state);
		const write = Atomics.load(this.#control, WRITE);
		const latency = Atomics.load(this.#control, LATENCY);
		const buffered = write - read | 0;
		if (!this.buffered && latency > 0 && buffered > latency) {
			const skipTo = write - latency | 0;
			if ((skipTo - read | 0) > 0) read = skipTo;
		}
		const available = write - read | 0;
		const count = Math.min(available, output[0].length);
		if (count <= 0) {
			if ((read - readOf(state) | 0) > 0) Atomics.compareExchange(this.#state, 0, state, pack(epochOf(state), read));
			return 0;
		}
		for (let channel = 0; channel < this.channels; channel++) {
			const src = this.#samples[channel];
			const dst = output[channel];
			for (let i = 0; i < count; i++) dst[i] = src[slot(read + i | 0, this.capacity)];
		}
		const next = pack(epochOf(state), read + count | 0);
		if (Atomics.compareExchange(this.#state, 0, state, next) !== state) {
			for (let channel = 0; channel < this.channels; channel++) output[channel].fill(0, 0, count);
			return 0;
		}
		return count;
	}
	/**
	* Update the target latency in samples. Main thread only.
	*
	* A deeper floor parks playback until it refills. Video holds the extra delay on its own, so
	* audio that kept draining at the old depth would run ahead by the difference. Parking keeps
	* what is buffered, so a rise costs only its own size in silence, and none if the buffer
	* already covers the new floor.
	*/
	setLatency(samples) {
		const previous = Atomics.exchange(this.#control, LATENCY, samples);
		if (previous > 0 && samples > previous) {
			Atomics.store(this.#control, STALLED, 1);
			this.#step(2);
		}
		this.#resume();
	}
	/**
	* Drop buffered samples at or after \`timestamp\`, keeping whatever is already due.
	* Main thread only.
	*
	* A successor track overwrites the slots its own samples land on, but anything the previous
	* track wrote beyond them would otherwise still play once the successor runs out.
	*/
	truncate(timestamp) {
		const target = Math.round(Second.fromMicro(timestamp) * this.rate) - this.#anchor | 0;
		if ((Atomics.load(this.#control, WRITE) - target | 0) <= 0) return;
		this.#step(1);
		for (;;) {
			const write = Atomics.load(this.#control, WRITE);
			const clamped = i32Max(target, readOf(Atomics.load(this.#state, 0)));
			if ((write - clamped | 0) <= 0) break;
			if (Atomics.compareExchange(this.#control, WRITE, write, clamped) === write) break;
		}
		this.#step(1);
	}
	/**
	* Flush buffered samples and re-stall, ready to anchor the next utterance (buffered mode).
	* Main thread only. The worklet reader sees STALLED and stops until the next insert.
	*/
	reset() {
		this.#anchored = false;
		Atomics.store(this.#control, STALLED, 1);
		const write = Atomics.load(this.#control, WRITE);
		const state = Atomics.load(this.#state, 0);
		Atomics.store(this.#state, 0, pack(epochOf(state), write));
	}
	/**
	* Allocate a new ring with \`newCapacity\` samples and copy the unread window
	* [READ, WRITE) plus control state into it. Used when growing capacity so
	* we don't drop buffered audio. If \`newCapacity\` is smaller than the unread
	* span, the oldest samples are truncated.
	*
	* Main thread only. \`resize()\` reads from the source \`SharedRingBuffer\` and
	* writes into a freshly allocated buffer from \`allocSharedRingBuffer\`, so it
	* relies on the same invariant as \`insert()\`: no concurrent main-thread
	* writers. The AudioWorklet reader is tolerated via the CAS discipline used
	* by READ/WRITE elsewhere.
	*/
	resize(newCapacity) {
		const init = allocSharedRingBuffer(this.channels, newCapacity, this.rate, this.buffered);
		const dst = new SharedRingBuffer(init);
		dst.#anchored = this.#anchored;
		dst.#anchor = this.#anchor;
		const state = Atomics.load(this.#state, 0);
		const read = readOf(state);
		const write = Atomics.load(this.#control, WRITE);
		const latency = Atomics.load(this.#control, LATENCY);
		const stalled = Atomics.load(this.#control, STALLED);
		const available = write - read | 0;
		const copyCount = Math.max(0, Math.min(available, dst.capacity));
		const copyStart = write - copyCount | 0;
		for (let channel = 0; channel < this.channels; channel++) {
			const src = this.#samples[channel];
			const out = dst.#samples[channel];
			for (let i = 0; i < copyCount; i++) {
				const idx = copyStart + i | 0;
				out[slot(idx, dst.capacity)] = src[slot(idx, this.capacity)];
			}
		}
		Atomics.store(dst.#control, TIMELINE, Atomics.load(this.#control, TIMELINE));
		Atomics.store(dst.#state, 0, pack(epochOf(state), copyStart));
		Atomics.store(dst.#control, WRITE, write);
		Atomics.store(dst.#control, LATENCY, latency);
		Atomics.store(dst.#control, STALLED, stalled);
		dst.#position = this.#foldRead(read) + (copyStart - read | 0);
		dst.#lastRead = copyStart;
		return dst;
	}
	/**
	* Fold an observed READ into \`#position\`, so the returned offset keeps counting up across
	* the i32 wrap. Idempotent: folding the same value twice adds a zero delta.
	*/
	#foldRead(read) {
		this.#position += read - this.#lastRead | 0;
		this.#lastRead = read;
		return this.#position;
	}
	/** \`#foldRead\` against the current READ. */
	#unwrapRead() {
		return this.#foldRead(readOf(Atomics.load(this.#state, 0)));
	}
	/**
	* Current playback timestamp derived from READ position.
	*
	* Main thread only, and stateful: it advances the unwrapped read position, so it has to be
	* polled rather than sampled once. See \`#position\`.
	*/
	get timestamp() {
		return Micro.fromSecond((this.#anchor + this.#unwrapRead()) / this.rate);
	}
	/** Whether an insert has anchored the ring since it was created or reset. Main thread only. */
	get anchored() {
		return this.#anchored;
	}
	/** Whether the buffer is stalled (waiting to fill). */
	get stalled() {
		return Atomics.load(this.#control, STALLED) === 1;
	}
	/**
	* Number of buffered samples (WRITE - READ).
	*
	* Non-atomic: WRITE and READ are loaded separately, so a concurrent
	* writer/reader can make the two loads inconsistent. Intended for
	* tests and diagnostics, not control-flow decisions.
	*/
	get length() {
		return Atomics.load(this.#control, WRITE) - readOf(Atomics.load(this.#state, 0)) | 0;
	}
};
//#endregion
//#region src/audio/render-worklet.ts
var Render = class extends AudioWorkletProcessor {
	#backend;
	#underflow = 0;
	#stateCounter = 0;
	#epoch = 0;
	constructor() {
		super();
		this.port.onmessage = (event) => {
			const msg = event.data;
			if (msg.type === "init-shared") {
				console.log("[audio-worklet] init-shared: using SharedArrayBuffer path");
				const previous = this.#backend instanceof SharedRingBuffer ? this.#backend : void 0;
				this.#backend = new SharedRingBuffer(msg, previous);
				this.#underflow = 0;
			} else if (msg.type === "init-post") {
				console.log("[audio-worklet] init-post: using postMessage path");
				this.#backend = new AudioRingBuffer(msg);
				this.#underflow = 0;
			} else if (msg.type === "data") {
				if (this.#backend instanceof AudioRingBuffer) this.#backend.write(msg.timestamp, msg.data);
			} else if (msg.type === "latency") {
				if (this.#backend instanceof AudioRingBuffer) this.#backend.resize(msg.latency);
			} else if (msg.type === "truncate") {
				if (this.#backend instanceof AudioRingBuffer) this.#backend.truncate(msg.timestamp);
			} else if (msg.type === "reset") {
				if (this.#backend instanceof AudioRingBuffer) this.#backend.reset();
				this.#epoch = msg.epoch;
			}
		};
	}
	process(_inputs, outputs, _parameters) {
		const output = outputs[0];
		const backend = this.#backend;
		const samplesRead = backend?.read(output) ?? 0;
		if (samplesRead < output[0].length) this.#underflow += output[0].length - samplesRead;
		else if (this.#underflow > 0 && backend) {
			console.debug(\`audio underflow: \${Math.round(1e3 * this.#underflow / backend.rate)}ms\`);
			this.#underflow = 0;
		}
		if (backend instanceof AudioRingBuffer) {
			this.#stateCounter++;
			if (this.#stateCounter >= 5) {
				this.#stateCounter = 0;
				const state = {
					type: "state",
					timestamp: backend.timestamp,
					stalled: backend.stalled,
					anchored: backend.anchored,
					epoch: this.#epoch
				};
				this.port.postMessage(state);
			}
		}
		return true;
	}
};
registerProcessor("render", Render);
//#endregion
`],{type:"application/javascript"}),Ge=URL.createObjectURL(qe),Je=class{#t=0;#e;#i;#n;#s=0;#a;get end(){return this.#e}clear(t=0){this.#t=0,this.#e=void 0,this.#s=t,this.#r()}update(t){let e=t.discontinuity!==this.#t;return e&&(this.#t=t.discontinuity,this.#e=void 0,this.#r()),t.frame&&t.group!==this.#i&&(this.#e=void 0),t.frame&&this.#n===void 0&&(this.#n=t.frame.timestamp),t.end!==void 0&&(this.#e=t.end,this.#i=t.group),e}span(t){let e=this.#n??t.timestamp;this.#n=e;let i=Math.floor(this.#s*t.sampleRate/48e3),n=this.#a??i,s=Math.min(n,t.numberOfFrames);this.#a=n-s;let a=Math.round(i*1e6/t.sampleRate),r=Math.max(e,t.timestamp-a),o=t.numberOfFrames-s;if(this.#e!==void 0)if(this.#e<=r)o=0;else{let c=this.#e-r,l=Math.round(c*t.sampleRate/1e6);o=Math.min(o,l)}return{timestamp:r,frameOffset:s,frames:o}}#r(){this.#n=void 0,this.#a=void 0}},Qe=class{#t;constructor(t){this.#t=t}drop(){return this.#t!==0&&(this.#t--,!0)}},Xe=3,Z=class{in;source;sync;#t={context:new u(void 0),root:new u(void 0),sampleRate:new u(void 0),stats:new u(void 0),timestamp:new u(void 0),stalled:new u(!0),buffered:new u([])};out=this.#t;#e=new u([]);#i;#n=new u(void 0);#s=new Je;#a=new Ke;#r=new v;#o;#c;constructor(t){this.in={enabled:g(t?.enabled??!0)},this.source=t.source,this.sync=t.sync,this.#r.cleanup(this.sync.register(this.source.out.jitter)),this.#o=this.#r.computed(e=>{let i=e.get(this.source.out.config);return i?Ve(i):void 0}),this.#c=this.#r.computed(e=>{let i=e.get(this.source.out.config);return i?ie(i):void 0}),this.#r.run(this.#l.bind(this)),this.#r.run(this.#h.bind(this)),this.#r.run(this.#d.bind(this)),this.#r.run(this.#f.bind(this))}#l(t){let e=t.get(this.#c);if(!e)return;let i=t.get(this.#n)??e.sampleRate,n=e.numberOfChannels;t.set(this.#t.sampleRate,i);let s=new AudioContext({latencyHint:"interactive",sampleRate:i});t.set(this.#t.context,s),t.cleanup(()=>s.close()),t.spawn(async()=>{if(!await t.race(s.audioWorklet.addModule(Ge).then(()=>!0)))return;let a=new AudioWorkletNode(s,"render",{channelCount:n,channelCountMode:"explicit",outputChannelCount:[n]});t.cleanup(()=>a.disconnect());let r=this.sync.out.delay.peek(),o=Ut(i,r),c=this.sync.out.buffered.peek(),l=je(a,n,i,o,c);this.#i=l,t.cleanup(()=>{l.close(),this.#i=void 0}),t.run(d=>{let p=h.Milli.fromMicro(d.get(l.timestamp));this.#t.timestamp.set(p),this.#A(p)}),t.run(d=>{this.#t.stalled.set(d.get(l.stalled))}),t.set(this.#t.root,a)})}#h(t){if(!t.get(this.in.enabled))return;if(t.get(this.sync.in.delay)==="instant"){this.reset();return}let e=t.get(this.#t.context);e&&_t.unlock(t,e)}#d(t){if(!t.get(this.#t.root))return;let e=this.#i;if(!e)return;let i=t.get(this.sync.out.delay);e.setLatency(Ut(e.rate,i))}#f(t){if(!t.get(this.in.enabled)||t.get(this.sync.in.delay)==="instant")return;let e=t.get(this.source.in.broadcast);if(!e)return;let i=t.get(this.source.out.track);if(!i)return;let n=t.get(this.#o);if(!n)return;let s=n.decoder,a=e.relativeBroadcast(t,n.broadcast);if(!a)return;this.#a.opened();let r=ft(t,{broadcast:a,track:i,priority:D.audio,maxAge:this.sync.out.maxAge});r&&(s.container.kind==="cmaf"?this.#y(t,r,s):this.#b(t,r,s))}#b(t,e,i){let n=i.codec==="opus"&&i.description?G.preSkip(E.toBytes(i.description)):0;this.#s.clear(n);let s=i.container.kind==="loc"?new q.Format("audio"):new J.Format(i),a=new F(e,{format:s,maxAge:this.sync.out.maxAge});t.cleanup(()=>a.close()),t.run(r=>{let o=r.get(a.buffered),c=r.get(this.#e);this.#t.buffered.update(()=>N(o,c))}),t.spawn(async()=>{if(!await ct.polyfill())return;let r=new Qe(Xe),o=new AudioDecoder({output:f=>{let m=this.#s.span(f);if(r.drop()){f.close();return}this.#g(f,m)},error:f=>console.error("audio decoder error",f)});t.cleanup(()=>{o.state!=="closed"&&o.close()});let c=i.codec==="opus"?void 0:i.description?E.toBytes(i.description):void 0,l={codec:i.codec,sampleRate:i.sampleRate,numberOfChannels:i.numberOfChannels,description:c};o.configure(l);let d=this.#m(),p;for(;;){let f=await Q(a);if((f===void 0||f.end!==void 0||f.discontinuity!==(p??f.discontinuity))&&!await this.#u(t,o,l,d,d.flush()))return;if(!f)break;if(p=f.discontinuity,f.frame===void 0||f.end!==void 0){this.#p(f)&&(o.reset(),o.configure(l),d.reset());continue}let{frame:m}=f,y=h.Milli.fromMicro(m.timestamp);if(this.sync.received(y,"audio"),this.#t.stats.update(w=>({bytesReceived:(w?.bytesReceived??0)+m.payload.byteLength})),!await this.#u(t,o,l,d,d.push({...f,frame:m})))return}})}#y(t,e,i){if(i.container.kind!=="cmaf")return;let n=$(i.container.init),s=I.decodeInitSegment(n),a=i.description?E.toBytes(i.description):s.description,r=i.codec==="opus"&&a?G.preSkip(a):0;this.#s.clear(r);let o=i.codec==="opus"?void 0:i.description?E.toBytes(i.description):s.description,c=new F(e,{format:new I.Format(s),maxAge:this.sync.out.maxAge});t.cleanup(()=>c.close()),t.run(l=>{let d=l.get(c.buffered),p=l.get(this.#e);this.#t.buffered.update(()=>N(d,p))}),t.spawn(async()=>{if(!await ct.polyfill())return;let l=new AudioDecoder({output:m=>this.#g(m),error:m=>console.error("audio decoder error",m)});t.cleanup(()=>{l.state!=="closed"&&l.close()});let d={codec:i.codec,sampleRate:i.sampleRate,numberOfChannels:i.numberOfChannels,description:o};l.configure(d);let p=this.#m(),f;for(;;){let m=await Q(c);if((m===void 0||m.end!==void 0||m.discontinuity!==(f??m.discontinuity))&&!await this.#u(t,l,d,p,p.flush()))return;if(!m)break;if(f=m.discontinuity,m.frame===void 0){this.#p(m)&&(l.reset(),l.configure(d),p.reset());continue}let{frame:y}=m,w=h.Milli.fromMicro(y.timestamp);if(this.sync.received(w,"audio"),this.#t.stats.update(M=>({bytesReceived:(M?.bytesReceived??0)+y.payload.byteLength})),!await this.#u(t,l,d,p,p.push({...m,frame:y})))return}})}#m(){return this.sync.out.buffered.peek()?new qt(()=>({floor:h.Micro.fromMilli(this.sync.out.delay.peek()),maxDelay:h.Micro.fromMilli(this.sync.out.maxAge.peek())})):new qt(void 0)}async#u(t,e,i,n,s){for(let a of s){if(this.#p(a)&&(e.reset(),e.configure(i),n.reset()),!n.admit(a))continue;let{frame:r}=a;if(await this.#i?.wait(r.timestamp,t.abort),e.state==="closed")return!1;e.decode(new EncodedAudioChunk({type:r.keyframe?"key":"delta",data:r.payload,timestamp:r.timestamp}))}return!0}#g(t,e=this.#s.span(t)){let{timestamp:i,frameOffset:n,frames:s}=e,a=h.Milli.fromMicro(i);if(s===0){t.close();return}let r=this.#i;if(!r){t.close();return}if(t.sampleRate!==r.rate){this.#n.set(t.sampleRate),t.close();return}let o=s/t.sampleRate*1e6,c=h.Milli.fromMicro(o),l=h.Milli.add(a,c);this.#a.takeover()&&(r.truncate(i),this.#v(a)),this.#w(a,l);let d=Math.min(t.numberOfChannels,r.channels),p=[];for(let f=0;f<d;f++){let m=new Float32Array(s);t.copyTo(m,{format:"f32-planar",planeIndex:f,frameOffset:n,frameCount:s}),p.push(m)}r.insert(i,p),t.close()}#w(t,e){t>e||this.#e.mutate(i=>{for(let n of i)if(t<=n.end+1&&e>=n.start){n.start=h.Milli.min(n.start,t),n.end=h.Milli.max(n.end,e);return}i.push({start:t,end:e}),i.sort((n,s)=>n.start-s.start)})}#v(t){this.#e.mutate(e=>{for(;e.length>0&&e[e.length-1].start>=t;)e.pop();let i=e[e.length-1];i&&i.end>t&&(i.end=t)})}#A(t){this.#e.mutate(e=>{for(;e.length>0;){if(e[0].end>=t){e[0].start=h.Milli.max(e[0].start,t);break}e.shift()}})}reset(){this.#i?.reset()}#p(t){return this.#s.update(t)?(this.#i?.reset(),this.sync.reset(),!0):!1}close(){this.#r.close()}static supported=Ze};async function Ze(t){if(!at(t.container)){let i=t.container.kind==="unknown"?t.container.raw.kind:t.container.kind;return console.warn(`audio: ignoring rendition with unknown container: ${i}`),!1}t.codec==="opus"&&!G.supportsRate(t.sampleRate)&&console.warn(`audio: opus advertised at ${t.sampleRate}Hz, which some browsers cannot decode`);let e;if(t.codec!=="opus"){if(t.description)e=E.toBytes(t.description);else if(t.container.kind==="cmaf")try{e=I.decodeInitSegment($(t.container.init)).description}catch(i){return console.warn(`audio: malformed CMAF init segment for codec ${t.codec}`,i),!1}}return(await AudioDecoder.isConfigSupported({...t,description:e})).supported??!1}var Gt=.001,ut=.2,pt=class{source;in;#t={enabled:new u(!1)};out=this.#t;#e=new v;#i=new u(void 0);constructor(t){this.source=t.source,this.in={volume:g(t?.volume??.5),muted:g(t?.muted??!1),paused:g(t?.paused??!1)},this.#e.run(e=>{let i=!e.get(this.in.paused)&&!e.get(this.in.muted);this.#t.enabled.set(i)}),this.#e.run(e=>{let i=e.get(this.source.out.root);if(!i)return;let n=new GainNode(i.context,{gain:e.get(this.in.volume)});i.connect(n),e.set(this.#i,n),e.run(s=>{s.get(this.#t.enabled)&&(n.connect(i.context.destination),s.cleanup(()=>n.disconnect()))})}),this.#e.run(e=>{let i=e.get(this.#i);if(!i)return;e.cleanup(()=>i.gain.cancelScheduledValues(i.context.currentTime));let n=e.get(this.in.volume);n<Gt?(i.gain.exponentialRampToValueAtTime(Gt,i.context.currentTime+ut),i.gain.setValueAtTime(0,i.context.currentTime+ut+.01)):i.gain.exponentialRampToValueAtTime(n,i.context.currentTime+ut)})}close(){this.#e.close()}},mt=class{in;#t={catalog:new u(void 0),available:new u({}),track:new u(void 0),config:new u(void 0),jitter:new u(void 0)};out=this.#t;#e=new v;constructor(t){this.in={broadcast:g(t?.broadcast),target:g(t?.target),supported:g(t?.supported)},this.#e.run(this.#i.bind(this)),this.#e.run(this.#n.bind(this)),this.#e.run(this.#s.bind(this))}#i(t){let e=t.get(this.in.broadcast);if(!e)return;let i=t.get(e.out.catalog)?.audio;i&&t.set(this.#t.catalog,i)}#n(t){let e=t.get(this.#t.catalog)?.renditions??{},i=t.get(this.in.supported);i&&t.spawn(async()=>{let n={};for(let[s,a]of Object.entries(e)){let r=await t.race(i(a));if(t.abort.aborted)return;r&&(n[s]=a)}Object.keys(n).length===0&&Object.keys(e).length>0&&console.warn("no supported audio renditions found:",e),this.#t.available.set(n)})}#s(t){let e=t.get(this.#t.available);if(Object.keys(e).length===0)return;let i=t.get(this.in.target),n;if(i?.name&&i.name in e)n={track:i.name,config:e[i.name]};else if(n=this.#a(e),!n)return;t.set(this.#t.track,n.track),t.set(this.#t.config,n.config),t.set(this.#t.jitter,$e(n.config))}#a(t){let e=Object.entries(t);if(e.length!==0){for(let[i,n]of e)if(n.container.kind==="legacy")return{track:i,config:n};for(let[i,n]of e)if(n.container.kind==="loc")return{track:i,config:n};for(let[i,n]of e)if(n.container.kind==="cmaf")return{track:i,config:n}}}close(){this.#e.close()}},ti=48e3,Jt=2;function ei(t){let e="";for(let i=0;i<t.length;i++)e+=t[i].toString(16).padStart(2,"0");return e}function ne(t){let e;try{e=t.initData?$(t.initData):void 0}catch{e=void 0}let i=e?ei(e):void 0;switch(t.packaging){case"cmaf":return!t.initData||!e?void 0:{container:{kind:"cmaf",init:t.initData},description:void 0};case"loc":return{container:{kind:"loc"},description:i};case"legacy":return{container:{kind:"legacy"},description:i};default:return}}function se(t){if(!(t<=0))return T(Math.ceil(t))}function ii(t){if(!t.codec)return;let e=ne(t);if(!e)return;let{container:i,description:n}=e;return{codec:t.codec,container:i,description:n,codedWidth:t.width==null?void 0:T(t.width),codedHeight:t.height==null?void 0:T(t.height),framerate:t.framerate,bitrate:t.bitrate==null?void 0:T(t.bitrate),stalled:t.stalled,jitter:t.jitter==null?void 0:T(t.jitter),delay:t.delay==null?void 0:se(t.delay)}}function ni(t){if(!t.codec)return;let e=(()=>{if(!t.channelConfig)return Jt;let a=Number.parseInt(t.channelConfig,10);return Number.isFinite(a)?a:Jt})(),i=ne(t);if(!i)return;let{container:n,description:s}=i;return{codec:t.codec,container:n,description:s,sampleRate:T(t.samplerate??ti),numberOfChannels:T(e),bitrate:t.bitrate==null?void 0:T(t.bitrate),jitter:t.jitter==null?void 0:T(t.jitter),delay:t.delay==null?void 0:se(t.delay)}}function si(t){let e={},i={};for(let s of t.tracks)if(s.role==="video"){let a=ii(s);a&&(e[s.name]=a)}else if(s.role==="audio"){let a=ni(s);a&&(i[s.name]=a)}let n={};return Object.keys(e).length>0&&(n.video={renditions:e}),Object.keys(i).length>0&&(n.audio={renditions:i}),n}function V(t,e){return Object.fromEntries(Object.entries(t).filter(([,i])=>e(i.broadcast)))}function ai(t,e){return{...t,video:t.video?{...t.video,renditions:V(t.video.renditions,e)}:void 0,audio:t.audio?{...t.audio,renditions:V(t.audio.renditions,e)}:void 0,text:t.text?{...t.text,renditions:V(t.text.renditions,e)}:void 0,json:t.json?{...t.json,tracks:V(t.json.tracks,e)}:void 0,binary:t.binary?{...t.binary,tracks:V(t.binary.tracks,e)}:void 0}}var ae=[...Dt,"hangz","manual"],gt=class{in;#t={status:new u("offline"),active:new u(void 0),catalog:new u(void 0)};out=this.#t;#e=new u(void 0);#i=new u(!1);#n=new u(void 0);#s;constructor(t){if(t&&"reload"in t)throw Error("Watch.Broadcast: `reload` was renamed to `announced`");this.#s=new v,this.in={origin:g(t?.origin),name:g(t?.name??B.empty()),enabled:g(t?.enabled??!0),announced:g(t?.announced??!0),catalogFormat:g(t?.catalogFormat),catalog:g(t?.catalog)},this.#s.run(this.#a.bind(this)),this.#s.run(this.#l.bind(this)),this.#s.run(this.#h.bind(this)),this.#s.run(this.#r.bind(this))}#a(t){if(this.#e.set(void 0),!t.get(this.#i)||!t.get(this.in.announced))return;let e=t.get(this.in.origin);if(!e)return;let i=e.announced();t.cleanup(()=>i.close()),this.#e.set(new Set),t.spawn(async()=>{for(;;){let n=await t.race(i.next());if(!n)break;this.#e.mutate(s=>{s&&(zt.isActive(n.kind)?s.add(n.prefix):s.delete(n.prefix))})}})}#r(t){let e=t.get(this.#n);t.set(this.#t.catalog,e?ai(e,i=>this.#d(t,i)!==void 0):void 0)}#o(t,e){this.#i.set(!0);let i=t.get(this.#e);if(!i)return!1;if(i.has(e))return!0;for(let n of i)if(B.hasPrefix(n,e))return!0;return!1}#c(t,e,i){let n=e.request(i);return t.cleanup(()=>n.close()),t.get(n.active)}#l(t){if(!t.get(this.in.enabled))return;let e=t.get(this.in.origin);if(!e)return;let i=t.get(this.in.name);if(!t.get(this.in.announced)){t.set(this.#t.active,this.#c(t,e,i),void 0);return}let n=e.request(i,{announced:!0});t.cleanup(()=>n.close()),t.run(s=>{s.set(this.#t.active,s.get(n.active),void 0)})}#h(t){if(!t.get(this.in.enabled))return;let e=t.get(this.in.catalogFormat),i=t.get(this.in.name),n=e??Nt(i)??Ft;if(n==="manual"){let c=t.get(this.in.catalog),l;try{l=c&&ot(rt(c),i)}catch(d){console.error("rejecting catalog",i,d)}this.#n.set(l,!0),t.cleanup(()=>this.#n.set(void 0,!0)),this.#t.status.set(l?"live":"loading");return}let s=t.get(this.out.active);if(!s||t.get(s.closed)!==void 0)return;this.#t.status.set("loading");let a=n==="hang"?Bt:n==="hangz"?Wt:"catalog",r=s.track(a).subscribe({priority:D.catalog});t.cleanup(()=>r.close());let o;if(n==="hang"||n==="hangz"){let c=new Pt.Consumer({track:r,schema:Ht,compression:n==="hangz"?"deflate":"none"});o=()=>c.next()}else{let c=r.ordered();o=async()=>{let l=await Yt(c);return l?si(l):void 0}}t.spawn(async()=>{try{for(;;){let c=await t.race(o());if(!c)break;console.debug("received catalog",n,this.in.name.peek(),c),this.#n.set(ot(rt(c),i),!0),this.#t.status.set("live")}}catch(c){c instanceof W.Stream?console.debug("catalog subscription ended",this.in.name.peek(),c):console.error("error fetching catalog",this.in.name.peek(),c)}finally{this.#n.set(void 0),this.#t.status.set("offline")}})}#d(t,e){if(!e)return{local:!0};let i=t.get(this.in.name),n=B.tryResolve(i,e);if(n===void 0){console.warn("ignoring rendition: broadcast reference escapes the root",i,e);return}if(n===i)return{local:!0};let s=t.get(this.in.origin);if(!s||!(t.get(this.in.announced)&&t.get(s.discovery)!==!1&&!this.#o(t,n)))return{local:!1,path:n}}relativeBroadcast(t,e){let i=this.#d(t,e);if(!i)return;if(i.local)return t.get(this.out.active);if(!t.get(this.in.enabled))return;let n=t.get(this.in.origin);if(n)return this.#c(t,n,i.path)}close(){this.#s.close()}},ri=h.Milli(20),Qt=h.Milli(100),bt=class re{in;#t={reference:new u(void 0),delay:new u(h.Milli.zero),jitter:new u(Qt),timestamp:new u(void 0),buffered:new u(!1),maxAge:new u(h.Milli.zero)};out=this.#t;#e=new Map;#i;#n=new u([]);#s=new v;constructor(e){this.in={delay:g(e?.delay??"auto"),buffer:g(e?.buffer??h.Milli.zero),probe:g(e?.probe)},this.#s.run(this.#r.bind(this)),this.#s.run(this.#o.bind(this)),this.#s.run(this.#a.bind(this))}register(e){let i={jitter:e};return this.#n.update(n=>[...n,i]),()=>this.#n.update(n=>n.filter(s=>s!==i))}#a(e){let i=e.get(this.#t.delay),n=e.get(this.in.delay)==="instant"?h.Milli.zero:e.get(this.in.buffer);this.#t.buffered.set(n>0),this.#t.maxAge.set(h.Milli.add(i,n))}#r(e){let i=e.get(this.in.delay);if(i==="instant"){this.#i=void 0,this.#t.jitter.set(h.Milli.zero);return}if(typeof i=="number"){this.#i=void 0,this.#t.jitter.set(i);return}let n=e.get(this.in.probe)?.rtt;if(n!==void 0){this.#i=this.#i===void 0?n:Math.min(this.#i,n);let s=h.Milli(Math.max(ri,this.#i*1.25));this.#t.jitter.set(s);return}this.#i=void 0,this.#t.jitter.set(Qt)}#o(e){let i=e.get(this.in.delay);if(typeof i=="number"){this.#t.delay.set(i);return}let n=e.get(this.#t.jitter),s=h.Milli.zero;for(let r of e.get(this.#n))s=h.Milli.max(s,e.get(r.jitter)??h.Milli.zero);let a=i==="instant"?h.Milli.zero:h.Milli.add(s,n);this.#t.delay.set(a)}received(e,i=""){this.#t.timestamp.update(l=>l===void 0||e>l?e:l);let n=h.Milli.now(),s=h.Milli.sub(n,e),a=this.#t.reference.peek();if(a===void 0){this.#t.reference.set(s);return}let r=this.#t.delay.peek(),o=h.Milli.add(h.Milli.sub(a,s),r);if(o<0){let l=this.#e.get(i);l?(l.count++,l.maxMs=Math.max(l.maxMs,-o)):this.#e.set(i,{count:1,maxMs:-o})}else{let l=this.#e.get(i);if(l){let d=i?`sync[${i}]`:"sync",p=re.#l(l.maxMs);console.debug(`${d}: ${l.count} late frame(s), max ${p} behind`),this.#e.delete(i)}}if(s>=a)return;let c=this.#t.maxAge.peek();o<=c||this.#t.reference.set(h.Milli.add(s,h.Milli.sub(c,r)))}reset(){this.#t.reference.set(void 0),this.#e.clear()}now(){let e=this.#t.reference.peek();if(e!==void 0)return h.Milli.sub(h.Milli.sub(h.Milli.now(),e),this.#t.delay.peek())}async wait(e){if(this.in.delay.peek()!=="instant"){if(this.#t.reference.peek()===void 0)throw Error("reference not set; call received() first");for(;;){if(this.in.delay.peek()==="instant")return;let i=h.Milli.now(),n=h.Milli.sub(i,e),s=this.#t.reference.peek();if(s===void 0)return;let a=h.Milli.add(h.Milli.sub(s,n),this.#t.delay.peek());if(a<=0||a<5||await this.#c(a))return}}}#c(e){return new Promise(i=>{let n=r=>{clearTimeout(s);for(let o of a)o();i(r)},s=setTimeout(()=>n(!0),e),a=[this.in.delay.changed(()=>n(!1)),this.#t.delay.changed(()=>n(!1)),this.#t.reference.changed(()=>n(!1))]})}static#l(e){if(e=Math.round(e),e<1e3)return`${e}ms`;let i=e/1e3;if(i<60)return`${Math.round(i*10)/10}s`;let n=i/60;return`${Math.round(n*10)/10}m`}close(){this.#s.close()}},oi=`:where([part=captions]){--overlay-padding:1%;--cue-color:white;--cue-bg-color:#000c;--cue-font-size:calc(var(--overlay-height) / 100 * 5);--cue-line-height:calc(var(--cue-font-size) * 1.2);--cue-padding-x:calc(var(--cue-font-size) * .6);--cue-padding-y:calc(var(--cue-font-size) * .4);z-index:1;contain:content;margin:var(--overlay-padding);font-size:var(--cue-font-size);box-sizing:border-box;pointer-events:none;user-select:none;word-spacing:normal;word-break:break-word;font-family:sans-serif;position:absolute;inset:0}:where([part=captions]>[part=cue-display]){contain:content;top:var(--cue-top);left:var(--cue-left);right:var(--cue-right);bottom:var(--cue-bottom);width:var(--cue-width,auto);height:var(--cue-height,auto);box-sizing:border-box;transform:var(--cue-transform);text-align:var(--cue-text-align);writing-mode:var(--cue-writing-mode,unset);white-space:pre-line;direction:ltr;unicode-bidi:plaintext;min-width:min-content;min-height:min-content;position:absolute;overflow:visible}:where([data-dir=rtl] [part=cue-display]){direction:rtl}:where([part=captions] [part=cue]){padding:var(--cue-padding-y) var(--cue-padding-x);line-height:var(--cue-line-height);background-color:var(--cue-bg-color);box-sizing:border-box;color:var(--cue-color);box-shadow:var(--cue-box-shadow);white-space:var(--cue-white-space,pre-wrap);outline:var(--cue-outline);text-shadow:var(--cue-text-shadow);display:inline-block}:where([part=captions] [part=cue-display][data-vertical] [part=cue]){padding:var(--cue-padding-x) var(--cue-padding-y)}
:where([part=captions] [part=region]){width:var(--region-width);height:var(--region-height);min-height:0;max-height:var(--region-height);writing-mode:horizontal-tb;top:calc(var(--region-top,var(--overlay-height) * var(--region-viewport-anchor-y) / 100 - var(--region-height) * var(--region-anchor-y) / 100));left:var(--region-left,calc(calc(var(--region-viewport-anchor-x) * 1%) - calc(var(--region-width) * var(--region-anchor-x) / 100)));right:var(--region-right);bottom:var(--region-bottom);overflow-wrap:break-word;box-sizing:border-box;flex-flow:column;justify-content:flex-start;display:inline-flex;position:absolute;overflow:hidden}:where([part=captions] [part=region][data-scroll=up]){justify-content:end}:where([part=captions] [part=region][data-active][data-scroll=up]){transition:top .433s}:where([part=captions] [part=region]>[part=cue-display]){width:auto;left:var(--cue-offset);height:var(--cue-height,auto);text-align:var(--cue-text-align);unicode-bidi:plaintext;margin-top:1px;position:relative}:where([part=captions] [part=region] [part=cue]){padding:calc(var(--cue-padding-y) / 2) var(--cue-padding-x);border-radius:0;position:relative}`,ci=h.Milli(3e4),li=h.Milli(3e4),hi=h.Milli(1e3);function tt(t){return t.replaceAll("&","&amp;amp;").replaceAll("<","&amp;lt;").replaceAll(">","&amp;gt;").replaceAll('"',"&amp;quot;")}function et(t,e){let i=t.length;for(;i>0&&t[i-1].startTime>e.startTime;)i--;t.splice(i,0,e)}function yt(t,e){let{cues:i,clears:n}=t,s=0;for(let r of n)r>=e&&(n[s++]=r);n.length=s;let a=0;for(let r of i)r.endTime>=e&&(i[a++]=r);return a!==i.length&&(i.length=a,!0)}function wt(t,e){let{cues:i,clears:n}=t,s=i.indexOf(e),a=s>0?i[s-1]:void 0;a&&a.endTime>e.startTime&&(a.endTime=e.startTime);let r=i[s+1];r&&e.endTime>r.startTime&&(e.endTime=r.startTime);let o=n.find(c=>c>e.startTime);o!==void 0&&e.endTime>o&&(e.endTime=o)}function vt(t,e){let{cues:i,clears:n}=t,s=n.length;for(;s>0&&n[s-1]>e;)s--;n[s]!==e&&n.splice(s,0,e);for(let a=i.length-1;a>=0;a--){let r=i[a];if(!(r.startTime>e)){r.endTime>e&&(r.endTime=e);return}}}var At=class{source;sync;in;#t=new v;#e=!1;constructor(t){this.source=t.source,this.sync=t.sync,this.in={container:g(t?.container),enabled:g(t?.enabled??!0)},this.#t.run(this.#i.bind(this))}#i(t){let e=t.getAll([this.in.enabled,this.in.container,this.source.out.track,this.source.out.config,this.source.in.broadcast]);if(!e)return;let[i,n,s,a,r]=e,o=r.relativeBroadcast(t,a.broadcast);if(!o)return;this.#e=!1;let c;if(a.container.kind==="legacy")c=new J.Format("data");else if(a.container.kind==="loc")c=new q.Format;else{console.warn(`captions: unsupported container "${a.container.kind}" for track ${s}`);return}let l=document.createElement("style");l.textContent=oi,n.appendChild(l),t.cleanup(()=>l.remove());let d=document.createElement("div");d.style.position="absolute",d.style.inset="0",d.style.pointerEvents="none",n.appendChild(d),t.cleanup(()=>d.remove());let p=new dt(d);t.cleanup(()=>p.destroy());let f=ft(t,{broadcast:o,track:s,priority:D.text,maxAge:this.sync.out.maxAge});if(!f)return;let m={cues:[],regions:new Map,clears:[]},y=()=>p.changeTrack({cues:[...m.cues],regions:[...m.regions.values()]}),w=()=>{let M=this.sync.now();M!==void 0&&(p.currentTime=M/1e3,yt(m,(M-ci)/1e3)&&y()),t.animate(w)};t.animate(w),t.spawn(async()=>{for(;;){let M=await f.recvGroup().catch(R=>{if(!(R instanceof W.Stream))throw R;console.debug("captions subscription ended",R)});if(!M)break;t.spawn(async()=>{try{for(;;){let R=await M.readFrame();if(!R)break;for(let ye of c.decode(R.payload))await this.#n(a.format,ye,m)}}catch(R){if(!(R instanceof W.Stream))throw R}finally{M.close()}y()})}})}async#n(t,e,i){let n=new TextDecoder().decode(e.payload),s=e.timestamp/1e6;if(t==="utf8"){if(n.length===0){vt(i,s);return}let o=new ht(s,s+li/1e3,tt(n));et(i.cues,o),wt(i,o);return}if(n.length===0)return;let a;try{a=await lt(n,{type:"vtt"})}catch(o){console.warn("captions: failed to parse VTT cue",o);return}let r=a.cues.at(0);!this.#e&&r&&Math.abs(r.startTime-s)>hi/1e3&&(this.#e=!0,console.warn(`captions: cue timing is ${(r.startTime-s).toFixed(3)}s off its frame timestamp; the payload must carry absolute times on the media clock`));for(let o of a.regions)i.regions.set(o.id,o);for(let o of a.cues)o.text=tt(o.text),et(i.cues,o)}close(){this.#t.close()}},di=new Set(["vtt","utf8"]);function kt(t){return di.has(t.format)}var xt=class{in;#t={catalog:new u(void 0),available:new u({}),track:new u(void 0),config:new u(void 0)};out=this.#t;#e=new v;constructor(t){this.in={broadcast:g(t?.broadcast),target:g(t?.target)},this.#e.run(this.#i.bind(this)),this.#e.run(this.#n.bind(this))}#i(t){let e=t.get(this.in.broadcast),i=e?t.get(e.out.catalog)?.text:void 0;t.set(this.#t.catalog,i),this.#t.available.set(i?.renditions??{})}#n(t){let e=t.get(this.#t.available),i=t.get(this.in.target),n=i?e[i]:void 0;if(!i||!n){t.set(this.#t.track,void 0),t.set(this.#t.config,void 0);return}kt(n)||console.warn(`captions: unsupported format ${JSON.stringify(n.format)} for track ${i}`),t.set(this.#t.track,i),t.set(this.#t.config,n)}close(){this.#e.close()}},oe=Symbol("supportCacheKey");function ce(t){return{broadcast:t.broadcast,decoder:{codec:t.codec,container:t.container,description:t.description,displayAspectWidth:t.displayAspectWidth,displayAspectHeight:t.displayAspectHeight,optimizeForLatency:t.optimizeForLatency??!0}}}function ui(t){return JSON.stringify(ce(t).decoder)}var fi=h.Milli(100);function pi(t){let e;return t.jitter===void 0?t.framerate&&(e=h.Milli(Math.ceil(1e3/t.framerate))):e=h.Milli(t.jitter),t.delay===void 0?e:h.Milli.add(h.Milli(t.delay),e??h.Milli.zero)}function mi(t){return t.active===void 0||h.Milli.add(t.playhead,fi)>=t.active}function gi(t){return t.active===void 0?t.pending:t.pending===void 0?t.active:h.Milli.max(t.active,t.pending)}function le(t=0){let e=(t%360+360)%360;return Math.round(e/90)%4*90}function he(t,e=0){let i=le(e);return i===90||i===270?{width:t.height,height:t.width}:{width:t.width,height:t.height}}function j(t){return Object.is(t,-0)?0:t}function bi(t,e){let[i,n,s,a,r,o]=t;return[j(-i),j(n),j(-s),j(a),j(e-r),j(o)]}function yi(t,e){let i=le(e?.rotation),n=he(t,i),s;switch(i){case 90:s=[0,1,-1,0,t.width,0];break;case 180:s=[-1,0,0,-1,t.width,t.height];break;case 270:s=[0,-1,1,0,0,t.height];break;default:s=[1,0,0,1,0,0]}return e?.flip&&(s=bi(s,t.width)),{matrix:s,source:n}}var wi=h.Milli(500),it=class{in;source;sync;#t={frame:new u(void 0),timestamp:new u(void 0),display:new u(void 0),stalled:new u(!1),stats:new u(void 0),jitter:new u(void 0),buffered:new u([])};out=this.#t;#e=new u(void 0);#i=new u(void 0);#n;#s=new v;#a(){this.#t.frame.update(t=>{t?.close()}),this.#t.timestamp.set(void 0)}constructor(t){this.in={enabled:g(t?.enabled??!0)},this.source=t.source,this.sync=t.sync,this.#s.cleanup(this.sync.register(this.out.jitter)),this.#n=this.#s.computed(e=>{let i=e.get(this.source.out.config);return i?ce(i):void 0}),this.#s.run(this.#r.bind(this)),this.#s.run(this.#o.bind(this)),this.#s.run(this.#c.bind(this)),this.#s.run(this.#l.bind(this)),this.#s.run(this.#h.bind(this))}#r(t){let e=(r,o)=>{if(r===void 0||o===void 0)return;let c=t.get(o)?.video?.renditions?.[r];return c&&pi(c)},i=t.get(this.#e),n=e(i?.track,i?.catalog),s=t.get(this.#i),a=e(s?.track,s?.catalog);t.set(this.#t.jitter,gi({active:n,pending:a}))}#o(t){let e=t.getAll([this.in.enabled,this.source.in.broadcast,this.source.out.track,this.#n]);if(!e){this.#e.set(void 0);return}let[i,n,s,a]=e,r=n.relativeBroadcast(t,a.broadcast);if(!r){this.#e.set(void 0),this.#a(),this.#t.buffered.set([]);return}let o=new vi({sync:this.sync,broadcast:r,track:s,config:a.decoder,stats:this.#t.stats,catalog:n.out.catalog});t.set(this.#i,{track:s,catalog:n.out.catalog}),t.cleanup(()=>o?.close()),t.run(c=>{if(!o)return;let l=c.get(this.#e);if(l){let d=c.get(o.timestamp);if(d===void 0||!mi({playhead:d,active:c.get(l.timestamp)}))return}this.#e.set(o),this.#i.set(void 0),o=void 0,c.close()})}#c(t){let e=t.get(this.#e);if(!e){this.#t.buffered.set([]);return}t.cleanup(()=>e.close()),t.run(i=>{let n=i.get(e.frame);n&&(this.#t.timestamp.set(h.Milli.fromMicro(n.timestamp)),this.#t.frame.update(s=>(s?.close(),n.clone())))}),t.proxy(this.#t.buffered,e.buffered)}#l(t){let e=t.get(this.source.out.catalog);if(!e)return;let i=e.display;if(i){t.set(this.#t.display,{width:i.width,height:i.height});return}let n=t.get(this.#t.frame);n&&t.set(this.#t.display,he({width:n.displayWidth,height:n.displayHeight},e.rotation))}#h(t){if(t.get(this.in.enabled)){if(!t.get(this.#t.frame)){this.#t.stalled.set(!0);return}this.#t.stalled.set(!1),t.timer(()=>{this.#t.stalled.set(!0)},wi)}}close(){this.#a(),this.#s.close()}static supported=de},vi=class{sync;broadcast;track;config;catalog;stats;timestamp=new u(void 0);frame=new u(void 0);buffered=new u([]);#t=new u([]);#e=0;#i=new v;constructor(t){this.sync=t.sync,this.broadcast=t.broadcast,this.track=t.track,this.config=t.config,this.catalog=t.catalog,this.stats=t.stats,this.#i.run(this.#n.bind(this))}#n(t){let e=ft(t,{broadcast:this.broadcast,track:this.track,priority:D.video,maxAge:this.sync.out.maxAge});if(!e)return;let i=new VideoDecoder({output:async n=>{try{let s=this.#e,a=h.Milli.fromMicro(n.timestamp);if(a<(this.timestamp.peek()??0)||this.sync.out.reference.peek()===void 0||(this.frame.peek()===void 0&&this.frame.set(n.clone()),!await t.race(this.sync.wait(a).then(()=>!0)))||s!==this.#e||a<(this.timestamp.peek()??0))return;this.timestamp.set(a),this.#c(a),this.frame.update(r=>(r?.close(),n.clone()))}finally{n.close()}},error:n=>{console.error("video decoder error",n),t.close()}});t.cleanup(()=>{i.state!=="closed"&&i.close()}),this.config.container.kind==="cmaf"?this.#a(t,e,i):this.#s(t,e,i)}#s(t,e,i){let n=this.config.container.kind==="loc"?new q.Format("video"):new J.Format(this.config),s=new F(e,{format:n,maxAge:this.sync.out.maxAge});t.cleanup(()=>s.close()),t.run(o=>{let c=o.get(s.buffered),l=o.get(this.#t);this.buffered.update(()=>N(c,l))}),i.configure({codec:this.config.codec,description:this.config.description?E.toBytes(this.config.description):void 0,displayAspectWidth:this.config.displayAspectWidth,displayAspectHeight:this.config.displayAspectHeight,optimizeForLatency:this.config.optimizeForLatency,flip:!1});let a,r;t.spawn(async()=>{for(;;){let o=await Q(s);if(!o)break;this.#r(o.discontinuity)&&(a=void 0);let{frame:c}=o;if(!c)continue;let l=r!==void 0&&o.group<r;if(this.stats.update(f=>({frameCount:(f?.frameCount??0)+ +!l,bytesReceived:(f?.bytesReceived??0)+c.payload.byteLength})),l)continue;let d=h.Milli.fromMicro(c.timestamp);this.sync.received(d,"video");let p=new EncodedVideoChunk({type:c.keyframe?"key":"delta",data:c.payload,timestamp:c.timestamp});a!==void 0&&o.continuous&&this.#o(h.Milli.fromMicro(a),h.Milli.fromMicro(c.timestamp)),a=c.timestamp,r=o.group,i.decode(p)}})}#a(t,e,i){let n=this.config.container;if(n.kind!=="cmaf")return;let s=$(n.init),a=I.decodeInitSegment(s),r=this.config.description?E.toBytes(this.config.description):a.description,o=new F(e,{format:new I.Format(a),maxAge:this.sync.out.maxAge});t.cleanup(()=>o.close()),t.run(d=>{let p=d.get(o.buffered),f=d.get(this.#t);this.buffered.update(()=>N(p,f))}),i.configure({codec:this.config.codec,description:r,displayAspectWidth:this.config.displayAspectWidth,displayAspectHeight:this.config.displayAspectHeight,optimizeForLatency:this.config.optimizeForLatency,flip:!1});let c,l;t.spawn(async()=>{for(;;){let d=await Q(o);if(!d)break;this.#r(d.discontinuity)&&(c=void 0);let{frame:p}=d;if(!p)continue;let f=l!==void 0&&d.group<l;if(this.stats.update(y=>({frameCount:(y?.frameCount??0)+ +!f,bytesReceived:(y?.bytesReceived??0)+p.payload.byteLength})),f)continue;let m=h.Milli.fromMicro(p.timestamp);if(this.sync.received(m,"video"),c!==void 0&&d.continuous&&this.#o(h.Milli.fromMicro(c),h.Milli.fromMicro(p.timestamp)),c=p.timestamp,i.state==="closed")break;l=d.group,i.decode(new EncodedVideoChunk({type:p.keyframe?"key":"delta",data:p.payload,timestamp:p.timestamp}))}})}#r(t){return t!==this.#e&&(this.#e=t,this.timestamp.set(void 0),this.#t.set([]),this.sync.reset(),!0)}#o(t,e){t>e||this.#t.mutate(i=>{for(let n of i)if(n.start<=e&&n.end>=t){n.start=h.Milli.min(n.start,t),n.end=h.Milli.max(n.end,e);return}i.push({start:t,end:e}),i.sort((n,s)=>n.start-s.start)})}#c(t){this.#t.mutate(e=>{for(;e.length>0;){if(e[0].end>=t){e[0].start=h.Milli.max(e[0].start,t);break}e.shift()}})}close(){this.#i.close(),this.frame.update(t=>{t?.close()})}};async function de(t){if(!at(t.container)){let n=t.container.kind==="unknown"?t.container.raw.kind:t.container.kind;return console.warn(`video: ignoring rendition with unknown container: ${n}`),!1}let e;if(t.description)e=E.toBytes(t.description);else if(t.container.kind==="cmaf")try{e=I.decodeInitSegment($(t.container.init)).description}catch(n){return console.warn(`video: malformed CMAF init segment for codec ${t.codec}`,n),!1}let{supported:i}=await VideoDecoder.isConfigSupported({codec:t.codec,description:e,displayAspectWidth:t.displayAspectWidth,displayAspectHeight:t.displayAspectHeight,optimizeForLatency:t.optimizeForLatency??!0});if(i)return!0;if(t.codec.startsWith("avc3.")){let n=`avc1.${t.codec.slice(5)}`;if((await VideoDecoder.isConfigSupported({codec:n,description:e,displayAspectWidth:t.displayAspectWidth,displayAspectHeight:t.displayAspectHeight,optimizeForLatency:t.optimizeForLatency??!0})).supported)return t.codec=n,!0}return!1}Object.assign(de,{[oe]:ui});var Xt=.01,Mt=class{decoder;in;#t={frame:new u(void 0),timestamp:new u(void 0),visible:new u(!1)};out=this.#t;#e=new u(void 0);#i=new v;constructor(t){this.decoder=t.decoder,this.in={canvas:g(t?.canvas),visible:g(t?.visible??"20%")},this.#i.run(e=>{let i=e.get(this.in.canvas);this.#e.set(i?.getContext("2d")??void 0)}),this.#i.run(this.#s.bind(this)),this.#i.run(this.#a.bind(this)),this.#i.run(this.#n.bind(this))}#n(t){let e=t.getAll([this.in.canvas,this.decoder.out.display]);if(!e)return;let[i,n]=e;(i.width!==n.width||i.height!==n.height)&&(i.width=n.width,i.height=n.height)}#s(t){let e=t.get(this.in.visible);if(e==="never"){this.#t.visible.set(!1);return}if(e==="always"){this.#t.visible.set(!0),t.cleanup(()=>this.#t.visible.set(!1));return}let i=t.get(this.in.canvas);if(!i){this.#t.visible.set(!1);return}let n=!1,s=()=>{this.#t.visible.set(n&&!document.hidden)},a=o=>{for(let c of o)n=c.isIntersecting,s()},r;try{r=new IntersectionObserver(a,{threshold:Xt,rootMargin:e})}catch{console.warn(`moq-watch: invalid visible margin "${e}", using "0px"`),r=new IntersectionObserver(a,{threshold:Xt})}s(),t.event(document,"visibilitychange",s),r.observe(i),t.cleanup(()=>r.disconnect()),t.cleanup(()=>this.#t.visible.set(!1))}#a(t){let e=t.get(this.#e);if(!e)return;let i=t.get(this.decoder.out.frame),n=t.get(this.decoder.source.out.catalog),s=requestAnimationFrame(()=>{this.#r(e,i,n),i?(this.#t.frame.update(a=>(a?.close(),i.clone())),this.#t.timestamp.set(h.Milli.fromMicro(i.timestamp))):(this.#t.frame.update(a=>{a?.close()}),this.#t.timestamp.set(void 0)),s=void 0});t.cleanup(()=>{s!==void 0&&cancelAnimationFrame(s)})}#r(t,e,i){if(!e){t.fillStyle="#000",t.fillRect(0,0,t.canvas.width,t.canvas.height);return}if(t.save(),t.fillStyle="#000",t.fillRect(0,0,t.canvas.width,t.canvas.height),!i?.rotation)i?.flip&&(t.scale(-1,1),t.translate(-t.canvas.width,0)),t.drawImage(e,0,0,t.canvas.width,t.canvas.height);else{let n=yi(t.canvas,i);t.setTransform(...n.matrix),t.drawImage(e,0,0,n.source.width,n.source.height)}t.restore()}close(){this.#t.frame.update(t=>{t?.close()}),this.#t.timestamp.set(void 0),this.#i.close()}};function Ai(t){return e=>{let i=[],n=[];for(let[s,a]of e)if(a.codedWidth&&a.codedHeight){let r=a.codedWidth*a.codedHeight;r<=t?i.push({name:s,size:r}):n.push({name:s,size:r})}return i.sort((s,a)=>a.size-s.size),i.length>0?i.map(s=>s.name):n.length>0?(n.sort((s,a)=>s.size-a.size),[n[0].name]):e.map(([s])=>s)}}function ue(t,e){return i=>{let n=[],s=[];for(let[a,r]of i){if(!r.codedWidth||!r.codedHeight)continue;let o=r.codedWidth*r.codedHeight,c=t==null||r.codedWidth<=t,l=e==null||r.codedHeight<=e;c&&l?n.push({name:a,size:o}):s.push({name:a,size:o})}return n.sort((a,r)=>r.size-a.size),n.length>0?n.map(a=>a.name):s.length>0?(s.sort((a,r)=>a.size-r.size),[s[0].name]):i.map(([a])=>a)}}function fe(t){return e=>{let i=[],n=[];for(let[s,a]of e)a.bitrate!=null&&a.bitrate<=t?i.push({name:s,bitrate:a.bitrate}):a.bitrate!=null&&n.push({name:s,bitrate:a.bitrate});return i.sort((s,a)=>a.bitrate-s.bitrate),i.length>0?i.map(s=>s.name):n.length>0?(n.sort((s,a)=>s.bitrate-a.bitrate),[n[0].name]):e.map(([s])=>s)}}function ki(t){let e=t[0];for(let i of t){let[,n]=i,[,s]=e,a=(n.codedWidth??0)*(n.codedHeight??0),r=(s.codedWidth??0)*(s.codedHeight??0);if(a!==r){a>r&&(e=i);continue}(n.bitrate??0)>(s.bitrate??0)&&(e=i)}return e[0]}function xi(t){let e=Object.entries(t).filter(([,a])=>!a.stalled);if(e.length>0)return Object.fromEntries(e);let i=Object.entries(t);if(i.length===0)return{};let n=fe(0)(i),s=n.length===1?n[0]:ue(0,0)(i)[0];return{[s]:t[s]}}var St=class{in;#t={catalog:new u(void 0),available:new u({}),error:new u(void 0),track:new u(void 0),config:new u(void 0)};out=this.#t;#e=new v;#i=new WeakMap;constructor(t){this.in={broadcast:g(t?.broadcast),target:g(t?.target),supported:g(t?.supported),probe:g(t?.probe)},this.#e.run(this.#n.bind(this)),this.#e.run(this.#s.bind(this)),this.#e.run(this.#a.bind(this))}#n(t){let e=t.get(this.in.broadcast);if(!e)return;let i=t.get(e.out.catalog)?.video;i&&t.set(this.#t.catalog,i)}#s(t){let e=t.get(this.in.supported);if(!e){this.#t.error.set(void 0);return}let i=t.get(this.#t.catalog)?.renditions??{};this.#t.error.set(void 0);let n=this.#i.get(e);n||(n=new Map,this.#i.set(e,n));let s=new Set(Object.keys(i));for(let a of n.keys())s.has(a)||n.delete(a);t.spawn(async()=>{let a={};for(let[o,c]of Object.entries(i)){let l=e[oe],d=l?l(c):JSON.stringify(c),p=n.get(o),f=!1;if(p?.key===d)f=p.supported;else{let m=!1;try{f=await t.race(e(c))}catch(y){m=!0,console.warn(`[Source] video rendition ${o} (${c.codec}) support probe failed; treating as unsupported`,y)}!m&&f!==void 0&&n.set(o,{key:l?l(c):JSON.stringify(c),supported:f})}if(t.abort.aborted)return;f&&(a[o]=c)}let r=Object.keys(a).length===0&&Object.keys(i).length>0?"unsupported":void 0;r==="unsupported"&&console.warn("[Source] No supported video renditions found:",i),this.#t.error.set(r),this.#t.available.set(a)})}#a(t){let e=t.get(this.#t.available),i=t.get(this.in.target);if(i?.name&&i.name in e){let o=e[i.name];t.set(this.#t.track,i.name),t.set(this.#t.config,o);return}let n=xi(e);if(Object.keys(n).length===0)return;let s=i;if(!i?.bitrate){let o=t.get(this.in.probe)?.estimatedRecvRate;if(o!=null){let c=Math.round(o*.8);s={...i,bitrate:c}}}let a=this.#r(n,s);if(!a)return;let r=n[a];t.set(this.#t.track,a),t.set(this.#t.config,r)}#r(t,e){let i=Object.entries(t);if(i.length===0)return;if(i.length===1)return i[0][0];let n=[];if(e?.pixels!=null&&n.push(Ai(e.pixels)),(e?.width!=null||e?.height!=null)&&n.push(ue(e.width,e.height)),e?.bitrate!=null&&n.push(fe(e.bitrate)),n.length===0)return ki(i);let s=n.map(r=>r(i)),a=s.map(r=>new Set(r));for(let r of s[0])if(a.every(o=>o.has(r)))return r;console.warn("conflicting rendition filters, no rendition satisfies all criteria")}close(){this.#e.close()}},pe=class{in;broadcast;sync;text;video;audio;renderer;emitter;textRenderer;#t=new u(!1);#e=new u(!1);#i=new u(!1);#n=new v;constructor(t={}){this.in={origin:g(t.origin),name:g(t.name??B.empty()),enabled:g(t.enabled??!0),announced:g(t.announced??!0),catalogFormat:g(t.catalogFormat),catalog:g(t.catalog),probe:g(t.probe),canvas:g(t.canvas),container:g(t.container),paused:g(t.paused??!1),volume:g(t.volume??.5),muted:g(t.muted??!1),visible:g(t.visible??"20%"),delay:g(t.delay??"auto"),buffer:g(t.buffer??h.Milli.zero),target:g(t.target),captions:g(t.captions)},this.broadcast=new gt(this.in),this.#n.cleanup(()=>this.broadcast.close());let e=new St({broadcast:this.broadcast,target:this.in.target,supported:it.supported,probe:this.in.probe}),i=new mt({broadcast:this.broadcast,supported:Z.supported});this.#n.cleanup(()=>{e.close(),i.close()}),this.text=new xt({broadcast:this.broadcast,target:this.in.captions}),this.#n.cleanup(()=>this.text.close()),this.sync=new bt({delay:this.in.delay,buffer:this.in.buffer,probe:this.in.probe}),this.#n.cleanup(()=>this.sync.close()),this.video=new it({source:e,sync:this.sync,enabled:this.#t}),this.audio=new Z({source:i,sync:this.sync,enabled:this.#e}),this.#n.cleanup(()=>{this.video.close(),this.audio.close()}),this.emitter=new pt({source:this.audio,volume:this.in.volume,muted:this.in.muted,paused:this.in.paused}),this.renderer=new Mt({decoder:this.video,canvas:this.in.canvas,visible:this.in.visible}),this.#n.cleanup(()=>{this.emitter.close(),this.renderer.close()}),this.textRenderer=new At({source:this.text,sync:this.sync,container:this.in.container,enabled:this.#i}),this.#n.cleanup(()=>this.textRenderer.close()),this.#n.run(n=>{this.#i.set(n.get(this.in.enabled)&&!n.get(this.in.paused))}),this.#n.run(n=>{this.#e.set(n.get(this.in.enabled)&&n.get(this.emitter.out.enabled))}),this.#n.run(n=>{let s=n.get(this.renderer.out.visible);n.get(this.in.enabled)?n.get(this.in.paused)?this.#t.set(s&&!n.get(this.renderer.out.frame)):this.#t.set(s):this.#t.set(!1)})}reset(){this.sync.reset(),this.audio.reset()}close(){this.#n.close()}};var me=Object.defineProperty,Tt=(t,e)=>{let i={};for(var n in t)me(i,n,{get:t[n],enumerable:!0});return e||me(i,Symbol.toStringTag,{value:"Module"}),i},Mi=Tt({Decoder:()=>Z,Emitter:()=>pt,Source:()=>mt}),Si=Tt({Renderer:()=>At,Source:()=>xt,clearCue:()=>vt,insertCue:()=>et,pruneCues:()=>yt,renderable:()=>kt,rollUp:()=>wt,sanitizeCue:()=>tt}),Ti=Tt({Decoder:()=>it,Renderer:()=>Mt,Source:()=>St});var Ri=navigator.userAgent.toLowerCase().includes("firefox"),Rt={aac:"mp4a.40.2",opus:"opus",av1:"av01.0.08M.08",h264:"avc1.640028",h265:"hev1.1.6.L93.B0",vp9:"vp09.00.10.08",vp8:"vp8"};async function be(t){return globalThis.AudioDecoder?(await AudioDecoder.isConfigSupported({codec:Rt[t],numberOfChannels:2,sampleRate:48e3})).supported===!0:!1}async function Y(t){let e=await VideoDecoder.isConfigSupported({codec:Rt[t],hardwareAcceleration:"prefer-software"}),i=await VideoDecoder.isConfigSupported({codec:Rt[t],hardwareAcceleration:"prefer-hardware"});return{hardware:Ri||i.config?.hardwareAcceleration!=="prefer-hardware"?void 0:i.supported===!0,software:e.supported===!0}}async function Ei(){return{webtransport:Lt.isWebTransportSupported()?"full":"partial",audio:{decoding:{aac:await be("aac"),opus:await be("opus")?"full":"partial"},render:typeof AudioContext<"u"&&typeof AudioBufferSourceNode<"u"},video:{decoding:typeof VideoDecoder<"u"?{h264:await Y("h264"),h265:await Y("h265"),vp8:await Y("vp8"),vp9:await Y("vp9"),av1:await Y("av1")}:void 0,render:typeof OffscreenCanvas<"u"&&typeof CanvasRenderingContext2D<"u"}}}export{ge as Watch,Ei as isSupported};
