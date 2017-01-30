/* jshint plusplus:false */
/* jshint quotmark:false */
compositor = (function(){
    var VERTEX_SIZE = 2;
    var COLOR_SIZE = 4;
    var TEXTURE_SIZE = 1;
    var REGION_SIZE = 2;

    var ELEMENT_SIZE = VERTEX_SIZE + COLOR_SIZE + TEXTURE_SIZE + REGION_SIZE;
    var ELEMENT_OFFSET = ELEMENT_SIZE * Float32Array.BYTES_PER_ELEMENT;

    var VERTEX_ELEMENT = 0;
    var COLOR_ELEMENT = VERTEX_ELEMENT + VERTEX_SIZE;
    var TEXTURE_ELEMENT = COLOR_ELEMENT + COLOR_SIZE;
    var REGION_ELEMENT = TEXTURE_ELEMENT + TEXTURE_SIZE;

    var VERTEX_OFFSET = VERTEX_ELEMENT * Float32Array.BYTES_PER_ELEMENT;
    var COLOR_OFFSET = COLOR_ELEMENT * Float32Array.BYTES_PER_ELEMENT;
    var TEXTURE_OFFSET = TEXTURE_ELEMENT * Float32Array.BYTES_PER_ELEMENT;
    var REGION_OFFSET = REGION_ELEMENT * Float32Array.BYTES_PER_ELEMENT;

    var ELEMENTS_PER_QUAD = 4;
    var INDICES_PER_QUAD = 6;/*jshint ignore:line*/

    var MAX_LENGTH = 16000;


    var api = me.WebGLRenderer.Compositor.extend(
        /** @scope me.WebGLRenderer.Compositor.prototype */
        {
            /**
             * @ignore
             */
            init : function (renderer) {
                var gl = renderer.gl;
                /**
                 * The number of quads held in the batch
                 * @name length
                 * @memberOf me.WebGLRenderer.Compositor
                 * @type Number
                 * @readonly
                 */
                this.length = 0;

                // Hash map of texture units
                this.units = [];
                this.maxTextures = gl.getParameter(
                    gl.MAX_TEXTURE_IMAGE_UNITS
                );

                // Vector pool
                this.v = [
                    new me.Vector2d(),
                    new me.Vector2d(),
                    new me.Vector2d(),
                    new me.Vector2d()
                ];
                this.renderer = renderer;

                // WebGL context
                this.gl = renderer.gl;

                // Global transformation matrix
                this.matrix = renderer.currentTransform;

                // Global color
                this.color = renderer.currentColor;

                // Uniform projection matrix
                this.uMatrix = new me.Matrix2d();

                // Detect GPU capabilities
                var precision = (gl.getShaderPrecisionFormat(
                    gl.FRAGMENT_SHADER,
                    gl.HIGH_FLOAT
                ).precision < 16) ? "mediump" : "highp";

                // Load and create shader programs
                this.lineShader = me.video.shader.createShader(
                    this.gl,
                    (function anonymous(){var out='precision highp float;attribute vec2 aVertex;uniform mat3 uMatrix;void main(void){gl_Position=vec4((uMatrix*vec3(aVertex,1)).xy,0,1);}';return out;})(),
                    (function anonymous(ctx){var out='precision '+(ctx.precision)+' float;uniform vec4 uColor;void main(void){gl_FragColor=uColor;}';return out;})({
                        "precision"     : precision
                    })
                );
                this.quadShader = me.video.shader.createShader(
                    this.gl,
                    (function anonymous(){var out='precision highp float;attribute vec2 aVertex;attribute vec4 aColor;attribute float aTexture;attribute vec2 aRegion;uniform mat3 uMatrix;varying vec4 vColor;varying float vTexture;varying vec2 vRegion;void main(void){gl_Position=vec4((uMatrix*vec3(aVertex,1)).xy,0,1);vColor=aColor;vTexture=aTexture;vRegion=aRegion;}';return out;})(),
                    (function anonymous(ctx){var out='precision '+(ctx.precision)+' float;uniform sampler2D uSampler['+(ctx.maxTextures)+'];uniform vec2 Resolution;uniform vec4 AmbientColor;uniform vec3 LightPos;uniform vec4 LightColor;uniform vec3 Falloff;uniform float LightSize;varying vec4 vColor;varying float vTexture;varying vec2 vRegion;void main(void){int texture=int(vTexture);vec4 DiffuseColor;vec3 NormalMap;if(texture==0){DiffuseColor=texture2D(uSampler[0],vRegion);NormalMap=texture2D(uSampler[0],vRegion.st+vec2(0.5,0.0)).rgb;}';for(var i=1;i<ctx.maxTextures-1;i++){out+='else if(texture=='+(i)+'){DiffuseColor=texture2D(uSampler['+(i)+'],vRegion);NormalMap=texture2D(uSampler['+(i)+'],vRegion.st+vec2(0.5,0.0)).rgb;}';}out+='else{DiffuseColor=texture2D(uSampler['+(ctx.maxTextures-1)+'],vRegion);NormalMap=texture2D(uSampler['+(ctx.maxTextures-1)+'],vRegion.st+vec2(0.5,0.0)).rgb;}vec3 LightDir=vec3(LightPos.xy-(gl_FragCoord.xy/Resolution.xy),LightPos.z);LightDir.x/=(LightSize/Resolution.x);LightDir.y/=(LightSize/Resolution.y);float D=length(LightDir);vec3 N=normalize(NormalMap*2.0-1.0);vec3 L=normalize(LightDir);N=mix(N,vec3(0),0.5);float df=max(dot(N,L),0.0);vec3 Diffuse=(LightColor.rgb*LightColor.a)*df;vec3 Ambient=AmbientColor.rgb*AmbientColor.a;float Attenuation=1.0/(Falloff.x+(Falloff.y*D)+(Falloff.z*D*D));vec3 Intensity=Ambient+Diffuse*Attenuation;vec3 FinalColor=DiffuseColor.rgb*Intensity;gl_FragColor=vColor*vec4(FinalColor,DiffuseColor.a);}';return out;})({
                        "precision"     : precision,
                        "maxTextures"   : this.maxTextures
                    })
                );

                this.shader = this.quadShader.handle;

                // Stream buffer
                this.sb = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.sb);
                gl.bufferData(
                    gl.ARRAY_BUFFER,
                    MAX_LENGTH * ELEMENT_OFFSET * ELEMENTS_PER_QUAD,
                    gl.STREAM_DRAW
                );

                this.sbSize = 256;
                this.sbIndex = 0;

                // Quad stream buffer
                this.stream = new Float32Array(
                    this.sbSize * ELEMENT_SIZE * ELEMENTS_PER_QUAD
                );

                // Index buffer
                this.ib = gl.createBuffer();
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ib);
                gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.createIB(), gl.STATIC_DRAW);

                // Bind attribute pointers for quad shader
                gl.vertexAttribPointer(
                    this.quadShader.attributes.aVertex,
                    VERTEX_SIZE,
                    gl.FLOAT,
                    false,
                    ELEMENT_OFFSET,
                    VERTEX_OFFSET
                );
                gl.vertexAttribPointer(
                    this.quadShader.attributes.aColor,
                    COLOR_SIZE,
                    gl.FLOAT,
                    false,
                    ELEMENT_OFFSET,
                    COLOR_OFFSET
                );
                gl.vertexAttribPointer(
                    this.quadShader.attributes.aTexture,
                    TEXTURE_SIZE,
                    gl.FLOAT,
                    false,
                    ELEMENT_OFFSET,
                    TEXTURE_OFFSET
                );
                gl.vertexAttribPointer(
                    this.quadShader.attributes.aRegion,
                    REGION_SIZE,
                    gl.FLOAT,
                    false,
                    ELEMENT_OFFSET,
                    REGION_OFFSET
                );

                this.reset();
                this.setProjection(gl.canvas.width, gl.canvas.height);

                // Initialize clear color and blend function
                gl.clearColor(0.0, 0.0, 0.0, 1.0);
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);


                this.quadShader.uniforms.Resolution = [800, 600];
                this.quadShader.uniforms.AmbientColor = [0.5, 0.5, 0.5, 0.85];
                this.quadShader.uniforms.LightPos = [0, 0, 0.075];
                this.quadShader.uniforms.LightColor = [1, 1, 1, 1];
                this.quadShader.uniforms.Falloff = [0.1, 7.0, 45.0];
                this.quadShader.uniforms.LightSize = 9500;
            }
        });
    return api;
}());